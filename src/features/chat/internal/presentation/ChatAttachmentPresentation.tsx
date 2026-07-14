import { useEvent } from 'expo';
import * as Sharing from 'expo-sharing';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  Share as NativeShare,
  Platform,
  Pressable,
  Text,
  View,
} from 'react-native';
import {
  Download,
  FileText,
  Image as ImageIcon,
  Play,
  Share2,
  Video,
  X,
} from 'lucide-react-native';

import type { MediaAttachment } from '../../../../domain/types';
import { saveAttachmentToDevice } from '../../../../services/mediaExport';
import { resolveAttachmentDisplayUri } from '../../../../services/mediaStorage';
import { requestNotice } from '../../../../ui/components/dialogService';
import { useChatAttachmentPresentationTheme } from './ChatAttachmentPresentationStyles';
function useAttachmentDisplayUri(attachment: MediaAttachment) {
  const requiresWebResolution =
    Platform.OS === 'web' && attachment.uri.startsWith('embezzle-web-attachment://');
  const [displayUri, setDisplayUri] = useState(requiresWebResolution ? '' : attachment.uri);
  const [displayError, setDisplayError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let temporaryUri: string | undefined;
    setDisplayError(null);
    setDisplayUri(requiresWebResolution ? '' : attachment.uri);
    void resolveAttachmentDisplayUri(attachment).then(
      (uri) => {
        if (disposed) {
          if (Platform.OS === 'web' && uri.startsWith('blob:')) URL.revokeObjectURL(uri);
          return;
        }
        temporaryUri = uri.startsWith('blob:') ? uri : undefined;
        setDisplayUri(uri);
      },
      (error) => {
        if (!disposed) {
          setDisplayError(error instanceof Error ? error.message : '附件预览不可用。');
        }
      }
    );
    return () => {
      disposed = true;
      if (Platform.OS === 'web' && temporaryUri) URL.revokeObjectURL(temporaryUri);
    };
  }, [attachment, requiresWebResolution]);

  return { displayUri, displayError };
}


export function PendingAttachmentPreview({
  attachment,
  onRemove,
}: {
  attachment: MediaAttachment;
  onRemove: () => void;
}) {
  const { palette, styles } = useChatAttachmentPresentationTheme();
  const { displayUri, displayError } = useAttachmentDisplayUri(attachment);

  return (
    <View style={styles.pendingAttachment}>
      {attachment.kind === 'image' && displayUri ? (
        <Image
          source={{ uri: displayUri }}
          resizeMode="cover"
          fadeDuration={0}
          style={styles.pendingAttachmentImage}
        />
      ) : (
        <View style={styles.pendingAttachmentFallback}>
          {attachment.kind === 'video' ? (
            <Video size={22} color={palette.textSecondary} strokeWidth={1.8} />
          ) : attachment.kind === 'image' ? (
            displayError ? (
              <ImageIcon size={22} color={palette.danger} strokeWidth={1.8} />
            ) : (
              <ActivityIndicator color={palette.textSecondary} size="small" />
            )
          ) : (
            <FileText size={22} color={palette.textSecondary} strokeWidth={1.8} />
          )}
        </View>
      )}
      <View style={styles.pendingAttachmentNameBar}>
        <Text numberOfLines={1} style={styles.pendingAttachmentName}>
          {attachment.name}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`移除附件 ${attachment.name}`}
        hitSlop={8}
        onPress={onRemove}
        style={({ pressed }) => [styles.pendingAttachmentRemove, pressed && styles.buttonPressed]}
      >
        <X size={14} color={palette.mediaOverlayText} strokeWidth={2.5} />
      </Pressable>
    </View>
  );
}


function VideoAttachmentSurface({ uri }: { uri: string }) {
  const { palette, styles } = useChatAttachmentPresentationTheme();
  const player = useVideoPlayer(uri, (createdPlayer) => {
    createdPlayer.loop = false;
    createdPlayer.staysActiveInBackground = false;
  });
  const { status } = useEvent(player, 'statusChange', { status: player.status });

  return (
    <View style={styles.attachmentVideoViewport}>
      <VideoView
        player={player}
        nativeControls
        contentFit="contain"
        fullscreenOptions={{ enable: true }}
        playsInline
        style={styles.attachmentVideoView}
      />
      {status === 'loading' ? (
        <View pointerEvents="none" style={styles.attachmentVideoStatusOverlay}>
          <ActivityIndicator color={palette.mediaOverlayText} />
          <Text style={styles.attachmentVideoStatusText}>正在加载视频</Text>
        </View>
      ) : status === 'error' ? (
        <View pointerEvents="none" style={styles.attachmentVideoStatusOverlay}>
          <Video size={24} color={palette.mediaOverlayText} strokeWidth={1.8} />
          <Text style={styles.attachmentVideoStatusText}>预览加载失败，可尝试保存或分享</Text>
        </View>
      ) : null}
    </View>
  );
}


export function AttachmentPreview({
  attachment,
  videoActive = false,
  onToggleVideo,
}: {
  attachment: MediaAttachment;
  videoActive?: boolean;
  onToggleVideo?: () => void;
}) {
  const { palette, styles } = useChatAttachmentPresentationTheme();
  const { displayUri, displayError } = useAttachmentDisplayUri(attachment);

  const openOrExport = () => {
    void (async () => {
      if (!displayUri) {
        throw new Error(displayError ?? '附件仍在准备预览，请稍后重试。');
      }
      if (Platform.OS === 'web') {
        await Linking.openURL(displayUri);
        return;
      }
      if (/^https?:\/\//i.test(displayUri)) {
        await NativeShare.share({ title: attachment.name, message: displayUri });
        return;
      }
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(displayUri, {
          dialogTitle: `导出 ${attachment.name}`,
          mimeType: attachment.mimeType,
        });
        return;
      }
      throw new Error('当前设备没有可用的文件导出应用。');
    })().catch((error) => {
      void requestNotice({
        title: '无法打开附件',
        description: error instanceof Error ? error.message : '请稍后重试。',
        tone: 'danger',
      });
    });
  };

  const saveToDevice = () => {
    void saveAttachmentToDevice(attachment)
      .then((result) => {
        if (result.status === 'saved') {
          void requestNotice({
            title: '已保存',
            description: `“${result.name}”已保存到你选择的位置。`,
            tone: 'primary',
          });
        }
      })
      .catch((error) => {
        void requestNotice({
          title: '无法保存附件',
          description: error instanceof Error ? error.message : '请稍后重试。',
          tone: 'danger',
        });
      });
  };

  if (attachment.kind === 'image') {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`打开或导出图片 ${attachment.name}`}
        onPress={openOrExport}
        style={styles.attachmentImageFrame}
      >
        {displayUri ? (
          <Image
            source={{ uri: displayUri }}
            resizeMode="cover"
            fadeDuration={0}
            style={styles.attachmentImage}
          />
        ) : (
          <View style={styles.attachmentImageFallback}>
            {displayError ? (
              <ImageIcon size={22} color={palette.danger} strokeWidth={1.8} />
            ) : (
              <ActivityIndicator color={palette.textSecondary} size="small" />
            )}
          </View>
        )}
      </Pressable>
    );
  }

  if (attachment.kind === 'video') {
    return (
      <View style={styles.attachmentVideoCard}>
        {videoActive && displayUri ? (
          <VideoAttachmentSurface uri={displayUri} />
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`在当前页面预览视频 ${attachment.name}`}
            disabled={!displayUri}
            onPress={onToggleVideo}
            style={({ pressed }) => [styles.attachmentVideoPlaceholder, pressed && styles.buttonPressed]}
          >
            {displayUri ? (
              <Play size={30} color={palette.textSecondary} fill={palette.textSecondary} strokeWidth={1.6} />
            ) : (
              <Video size={28} color={displayError ? palette.danger : palette.textSecondary} strokeWidth={1.8} />
            )}
            <Text style={styles.attachmentVideoPlaceholderText}>
              {displayError ? '视频预览不可用' : '点击在当前页面预览'}
            </Text>
          </Pressable>
        )}
        <View style={styles.attachmentVideoFooter}>
          <View style={styles.attachmentVideoTitleRow}>
            <Text numberOfLines={1} style={styles.attachmentVideoFileName}>
              {attachment.name}
            </Text>
            {videoActive ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`收起视频预览 ${attachment.name}`}
                onPress={onToggleVideo}
                hitSlop={8}
              >
                <Text style={styles.attachmentVideoCollapseText}>收起</Text>
              </Pressable>
            ) : null}
          </View>
          <View style={styles.attachmentVideoActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`保存视频 ${attachment.name}`}
              onPress={saveToDevice}
              style={({ pressed }) => [styles.attachmentSaveButton, pressed && styles.buttonPressed]}
            >
              <Download size={15} color={palette.textOnAccent} strokeWidth={2.2} />
              <Text style={styles.attachmentOpenButtonText}>保存</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`分享视频 ${attachment.name}`}
              onPress={openOrExport}
              style={({ pressed }) => [styles.attachmentShareButton, pressed && styles.buttonPressed]}
            >
              <Share2 size={15} color={palette.text} strokeWidth={2.2} />
              <Text style={styles.attachmentShareButtonText}>分享</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`打开或导出文件 ${attachment.name}`}
      onPress={openOrExport}
      style={styles.attachmentFile}
    >
      <Text style={styles.attachmentKind}>{attachment.kind.toUpperCase()}</Text>
      <Text numberOfLines={1} style={styles.attachmentFileName}>
        {attachment.name}
      </Text>
    </Pressable>
  );
}
