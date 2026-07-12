import { useEffect, useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import { NoticeDialog } from './NoticeDialog';
import {
  bindAppDialogHost,
  type DialogRequest,
} from './dialogService';

/**
 * Mount once near the app root (inside KelivoThemeProvider).
 * Powers requestConfirm / requestNotice so no browser confirm/alert is used.
 */
export function AppDialogHost() {
  const [request, setRequest] = useState<DialogRequest | null>(null);

  useEffect(() => {
    bindAppDialogHost(setRequest);
    return () => bindAppDialogHost(null);
  }, []);

  if (!request) {
    return null;
  }

  if (request.kind === 'confirm') {
    return (
      <ConfirmDialog
        visible
        title={request.title}
        description={request.description}
        subject={request.subject}
        confirmLabel={request.confirmLabel}
        cancelLabel={request.cancelLabel}
        tone={request.tone}
        onConfirm={() => request.resolve(true)}
        onCancel={() => request.resolve(false)}
      />
    );
  }

  return (
    <NoticeDialog
      visible
      title={request.title}
      description={request.description}
      buttonLabel={request.buttonLabel}
      tone={request.tone}
      onClose={() => request.resolve()}
    />
  );
}
