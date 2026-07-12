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
let pending: DialogRequest | null = null;

export function bindAppDialogHost(next: DialogListener | null): void {
  listener = next;
  if (listener && pending) {
    listener(pending);
  }
}

function present(request: DialogRequest): void {
  pending = request;
  if (!listener) {
    // Host not mounted yet — fail closed for confirms, no-op for notices.
    if (request.kind === 'confirm') {
      request.resolve(false);
    } else {
      request.resolve();
    }
    pending = null;
    return;
  }
  listener(request);
}

function clear(request: DialogRequest): void {
  if (pending === request) {
    pending = null;
    listener?.(null);
  }
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
    const request: ConfirmDialogRequest = {
      kind: 'confirm',
      title: options.title,
      description: options.description,
      subject: options.subject,
      confirmLabel: options.confirmLabel,
      cancelLabel: options.cancelLabel,
      tone: options.tone ?? 'danger',
      resolve: (confirmed) => {
        clear(request);
        resolve(confirmed);
      },
    };
    present(request);
  });
}

export function requestNotice(options: {
  title: string;
  description: string;
  buttonLabel?: string;
  tone?: DialogTone;
}): Promise<void> {
  return new Promise((resolve) => {
    const request: NoticeDialogRequest = {
      kind: 'notice',
      title: options.title,
      description: options.description,
      buttonLabel: options.buttonLabel,
      tone: options.tone ?? 'primary',
      resolve: () => {
        clear(request);
        resolve();
      },
    };
    present(request);
  });
}
