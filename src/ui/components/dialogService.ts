export type DialogTone = 'danger' | 'warning' | 'primary';

export interface ConfirmDialogRequest {
  kind: 'confirm';
  title: string;
  description: string;
  subject?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: DialogTone;
  resolve: (confirmed: boolean) => void;
}

export interface NoticeDialogRequest {
  kind: 'notice';
  title: string;
  description: string;
  buttonLabel?: string;
  tone?: DialogTone;
  resolve: () => void;
}

export type DialogRequest = ConfirmDialogRequest | NoticeDialogRequest;

type DialogListener = (request: DialogRequest | null) => void;

let listener: DialogListener | null = null;
let active: DialogRequest | null = null;
const queue: DialogRequest[] = [];

function settleWithoutHost(request: DialogRequest): void {
  if (request.kind === 'confirm') {
    request.resolve(false);
  } else {
    request.resolve();
  }
}

function presentNext(): void {
  if (!listener || active) {
    return;
  }
  active = queue.shift() ?? null;
  if (active) {
    listener(active);
  }
}

function finish(request: DialogRequest): void {
  if (active === request) {
    active = null;
    listener?.(null);
    presentNext();
    return;
  }

  const queuedIndex = queue.indexOf(request);
  if (queuedIndex >= 0) {
    queue.splice(queuedIndex, 1);
  }
}

export function bindAppDialogHost(next: DialogListener | null): void {
  listener = next;
  if (listener) {
    if (active) {
      listener(active);
    } else {
      presentNext();
    }
    return;
  }

  // A disappearing host must never leave a destructive confirmation or a
  // queued notice unresolved. Confirmations fail closed; notices complete.
  const abandoned = [...(active ? [active] : []), ...queue];
  active = null;
  queue.length = 0;
  abandoned.forEach(settleWithoutHost);
}

function enqueue(request: DialogRequest): void {
  if (!listener) {
    settleWithoutHost(request);
    return;
  }
  queue.push(request);
  presentNext();
}

export function requestConfirm(options: {
  title: string;
  description: string;
  subject?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: DialogTone;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const request: ConfirmDialogRequest = {
      kind: 'confirm',
      title: options.title,
      description: options.description,
      subject: options.subject,
      confirmLabel: options.confirmLabel,
      cancelLabel: options.cancelLabel,
      tone: options.tone ?? 'danger',
      resolve: (confirmed) => {
        if (settled) {
          return;
        }
        settled = true;
        finish(request);
        resolve(confirmed);
      },
    };
    enqueue(request);
  });
}

export function requestNotice(options: {
  title: string;
  description: string;
  buttonLabel?: string;
  tone?: DialogTone;
}): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const request: NoticeDialogRequest = {
      kind: 'notice',
      title: options.title,
      description: options.description,
      buttonLabel: options.buttonLabel,
      tone: options.tone ?? 'primary',
      resolve: () => {
        if (settled) {
          return;
        }
        settled = true;
        finish(request);
        resolve();
      },
    };
    enqueue(request);
  });
}
