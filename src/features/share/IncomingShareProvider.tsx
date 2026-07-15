import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState, Linking, Platform } from 'react-native';

import type { MediaAttachment } from '../../domain/types';
import {
  clearIncomingSharePayloads,
  emptyIncomingShareSnapshot,
  persistIncomingShareAttachmentsIfCurrent,
  readIncomingSharePayloads,
  resolveIncomingSharePayloads,
  type IncomingShareSnapshot,
} from '../../services/incomingShare';

export interface IncomingShareContextValue {
  snapshot: IncomingShareSnapshot;
  hasIncomingShare: boolean;
  isResolving: boolean;
  error?: string;
  refresh(): void;
  resolve(): Promise<IncomingShareSnapshot>;
  persistAttachments(snapshot?: IncomingShareSnapshot): Promise<MediaAttachment[]>;
  clear(expectedSnapshot?: IncomingShareSnapshot): boolean;
}

const IncomingShareContext = createContext<IncomingShareContextValue | null>(null);

function shareSnapshotFingerprint(snapshot: IncomingShareSnapshot): string {
  return snapshot.items
    .map((item) => [item.kind, item.value].join('|'))
    .join('\u001e');
}

/**
 * AppState can emit `active` immediately after a share resolver returns. Keep
 * the resolved preview in that case instead of replacing it with the raw
 * payload and forcing a second network/content-URI resolution.
 */
export function shouldReplaceIncomingShareSnapshot(
  current: IncomingShareSnapshot,
  nextRaw: IncomingShareSnapshot
): boolean {
  if (!current.items.length || !nextRaw.items.length) return true;
  if (shareSnapshotFingerprint(current) !== shareSnapshotFingerprint(nextRaw)) return true;
  return !current.items.some((item) => item.resolved);
}

function isSharingDeepLink(url: string): boolean {
  try {
    return new URL(url).hostname === 'expo-sharing';
  } catch {
    return url.includes('://expo-sharing');
  }
}

/**
 * Native share-intent state only. Destination selection and UI live at the
 * application shell so this provider can remain reusable and testable.
 */
export function IncomingShareProvider(props: { children: ReactNode }): React.ReactElement {
  const [snapshot, setSnapshot] = useState<IncomingShareSnapshot>(() =>
    Platform.OS === 'web' ? emptyIncomingShareSnapshot() : readIncomingSharePayloads()
  );
  const [isResolving, setIsResolving] = useState(false);
  const [error, setError] = useState<string>();
  const operationRef = useRef(0);
  const snapshotRef = useRef(snapshot);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  const refresh = useCallback(() => {
    if (Platform.OS === 'web') return;
    const nextRaw = readIncomingSharePayloads();
    if (shouldReplaceIncomingShareSnapshot(snapshotRef.current, nextRaw)) {
      operationRef.current += 1;
      snapshotRef.current = nextRaw;
      setSnapshot(nextRaw);
    }
    setError(undefined);
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    refresh();
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    const linking = Linking.addEventListener('url', ({ url }) => {
      if (isSharingDeepLink(url)) refresh();
    });
    return () => {
      appState.remove();
      linking.remove();
    };
  }, [refresh]);

  const resolve = useCallback(async (): Promise<IncomingShareSnapshot> => {
    if (Platform.OS === 'web') return emptyIncomingShareSnapshot();
    const operation = ++operationRef.current;
    setIsResolving(true);
    setError(undefined);
    try {
      const resolved = await resolveIncomingSharePayloads();
      if (operationRef.current === operation) {
        snapshotRef.current = resolved;
        setSnapshot(resolved);
      }
      return resolved;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '无法读取系统分享内容。';
      if (operationRef.current === operation) setError(message);
      throw reason;
    } finally {
      if (operationRef.current === operation) setIsResolving(false);
    }
  }, []);

  const persistAttachments = useCallback(
    (expectedSnapshot: IncomingShareSnapshot = snapshotRef.current) =>
      persistIncomingShareAttachmentsIfCurrent(
        expectedSnapshot.attachments,
        () => snapshotRef.current === expectedSnapshot
      ),
    []
  );

  const clear = useCallback((expectedSnapshot?: IncomingShareSnapshot): boolean => {
    if (expectedSnapshot && snapshotRef.current !== expectedSnapshot) return false;
    operationRef.current += 1;
    clearIncomingSharePayloads();
    snapshotRef.current = emptyIncomingShareSnapshot();
    setSnapshot(emptyIncomingShareSnapshot());
    setIsResolving(false);
    setError(undefined);
    return true;
  }, []);

  const value = useMemo<IncomingShareContextValue>(
    () => ({
      snapshot,
      hasIncomingShare: snapshot.items.length > 0,
      isResolving,
      ...(error ? { error } : {}),
      refresh,
      resolve,
      persistAttachments,
      clear,
    }),
    [clear, error, isResolving, persistAttachments, refresh, resolve, snapshot]
  );

  return <IncomingShareContext.Provider value={value}>{props.children}</IncomingShareContext.Provider>;
}

export function useIncomingShareInbox(): IncomingShareContextValue {
  const value = useContext(IncomingShareContext);
  if (!value) throw new Error('useIncomingShareInbox requires IncomingShareProvider.');
  return value;
}
