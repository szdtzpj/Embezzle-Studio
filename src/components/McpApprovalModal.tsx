import { AlertTriangle, Ban, Check, ShieldCheck, Square } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ProviderMcpApprovalDecision } from '../services/providerMcp';
import type { McpApprovalToken } from '../services/mcpLifecycle';

export interface McpApprovalViewModel {
  approvalRequestId: string;
  approvalNonce: number;
  providerName: string;
  modelId: string;
  serverName: string;
  serverLabel: string;
  endpoint: string;
  toolName: string;
  argumentsText: string;
  argumentBytes: number;
}

interface McpApprovalModalProps {
  visible: boolean;
  request: McpApprovalViewModel | null;
  onDecision: (token: McpApprovalToken, decision: ProviderMcpApprovalDecision) => void;
}

const colors = {
  background: '#F4F4F4',
  surface: '#FFFFFF',
  surfaceAlt: '#EAEAEA',
  text: '#0D0D0D',
  secondary: '#666666',
  border: '#D9D9D9',
  accent: '#0D0D0D',
  warning: '#9A4D09',
  warningBackground: '#FFF6E8',
  danger: '#A12828',
  dangerBackground: '#FFF0F0',
} as const;

function formatByteLength(bytes: number): string {
  const exact = `${bytes.toLocaleString('en-US')} B`;
  if (bytes < 1024) {
    return exact;
  }
  return `${(bytes / 1024).toFixed(1)} KB (${exact})`;
}

export function McpApprovalModal({
  visible,
  request,
  onDecision,
}: McpApprovalModalProps) {
  const insets = useSafeAreaInsets();
  const [decisionPending, setDecisionPending] = useState(false);
  const decisionPendingRef = useRef(false);

  useEffect(() => {
    decisionPendingRef.current = false;
    setDecisionPending(false);
  }, [request?.approvalRequestId, request?.approvalNonce]);

  const settleOnce = (decision: ProviderMcpApprovalDecision) => {
    if (!request || decisionPendingRef.current) {
      return;
    }
    decisionPendingRef.current = true;
    setDecisionPending(true);
    onDecision({
      approvalRequestId: request.approvalRequestId,
      nonce: request.approvalNonce,
    }, decision);
  };

  return (
    <Modal
      visible={visible && request !== null}
      animationType="slide"
      presentationStyle="fullScreen"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={() => settleOnce('cancel')}
    >
      <SafeAreaView style={styles.root}>
        <View style={styles.header}>
          <View style={styles.headerIcon}>
            <ShieldCheck size={22} color={colors.text} strokeWidth={2.2} />
          </View>
          <View style={styles.headerText}>
            <Text style={styles.title}>批准这一次工具调用？</Text>
            <Text style={styles.subtitle}>未批准前，Embezzle Studio 不会让服务商执行这个工具</Text>
          </View>
        </View>

        {request ? (
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={[styles.content, { paddingBottom: Math.max(24, insets.bottom + 16) }]}
          >
            <View style={styles.warningCard} testID="mcp-approval-warning">
              <AlertTriangle size={18} color={colors.warning} strokeWidth={2.2} />
              <Text style={styles.warningText}>
                工具由第三方 MCP 服务运行，可能读取或修改外部数据并产生服务商费用。批准后的副作用无法由本应用撤销。
              </Text>
            </View>

            <View style={styles.card} testID="mcp-approval-context">
              <Text style={styles.sectionTitle}>调用来源</Text>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>模型服务商</Text>
                <Text selectable style={styles.detailValue}>{request.providerName}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>模型</Text>
                <Text selectable style={styles.detailValue}>{request.modelId}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>MCP 服务</Text>
                <Text selectable style={styles.detailValue}>{request.serverName}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>服务标签</Text>
                <Text selectable style={styles.detailValue}>{request.serverLabel}</Text>
              </View>
              <View style={styles.detailColumn}>
                <Text style={styles.detailLabel}>HTTPS Endpoint</Text>
                <Text selectable style={styles.endpoint}>{request.endpoint}</Text>
              </View>
            </View>

            <View style={styles.card} testID="mcp-approval-payload">
              <View style={styles.payloadHeader}>
                <View style={styles.payloadTitleGroup}>
                  <Text style={styles.sectionTitle}>即将执行的工具</Text>
                  <Text selectable style={styles.toolName}>{request.toolName}</Text>
                </View>
                <Text style={styles.byteBadge}>{formatByteLength(request.argumentBytes)}</Text>
              </View>
              <Text style={styles.payloadHint}>以下为服务商拟发送给 MCP 服务的完整原始参数；内容仅作为文本显示。</Text>
              <ScrollView
                nestedScrollEnabled
                style={styles.codeScroller}
                contentContainerStyle={styles.codeContent}
              >
                <Text selectable style={styles.codeText}>{request.argumentsText || '{}'}</Text>
              </ScrollView>
            </View>

            <View style={styles.noticeCard}>
              <Text style={styles.noticeTitle}>三种选择的区别</Text>
              <Text style={styles.noticeText}>批准一次：仅批准上面这一项；后续工具仍会再次询问。</Text>
              <Text style={styles.noticeText}>拒绝并继续：不执行此工具，但会再请求模型继续回答，可能产生额外费用。</Text>
              <Text style={styles.noticeText}>取消整轮：停止当前回答，不再为这次审批发起续接请求。</Text>
            </View>
          </ScrollView>
        ) : null}

        <View style={[styles.footer, { paddingBottom: Math.max(12, insets.bottom) }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="取消整轮回答"
            disabled={decisionPending}
            onPress={() => settleOnce('cancel')}
            style={[styles.cancelButton, decisionPending && styles.actionDisabled]}
          >
            <Square size={14} color={colors.danger} strokeWidth={2.2} />
            <Text style={styles.cancelButtonText}>取消整轮</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="拒绝工具并让模型继续"
            disabled={decisionPending}
            onPress={() => settleOnce('deny')}
            style={[styles.denyButton, decisionPending && styles.actionDisabled]}
          >
            <Ban size={16} color={colors.text} strokeWidth={2.2} />
            <Text style={styles.denyButtonText}>拒绝并继续</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="仅批准这一次工具调用"
            disabled={decisionPending}
            onPress={() => settleOnce('approve')}
            style={[styles.approveButton, decisionPending && styles.actionDisabled]}
          >
            <Check size={17} color="#FFFFFF" strokeWidth={2.8} />
            <Text style={styles.approveButtonText}>批准一次</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    minHeight: 72,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headerIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceAlt },
  headerText: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 18, fontWeight: '700' },
  subtitle: { color: colors.secondary, fontSize: 11, lineHeight: 16 },
  scroll: { flex: 1 },
  content: { padding: 16, gap: 12 },
  warningCard: { padding: 13, borderRadius: 15, backgroundColor: colors.warningBackground, flexDirection: 'row', alignItems: 'flex-start', gap: 9 },
  warningText: { flex: 1, color: colors.warning, fontSize: 12, lineHeight: 18, fontWeight: '600' },
  card: { padding: 15, borderRadius: 18, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, gap: 10 },
  sectionTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  detailRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  detailColumn: { gap: 5 },
  detailLabel: { width: 82, color: colors.secondary, fontSize: 11, lineHeight: 18 },
  detailValue: { flex: 1, color: colors.text, fontSize: 12, lineHeight: 18, fontWeight: '600' },
  endpoint: { color: colors.text, fontSize: 11, lineHeight: 17 },
  payloadHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  payloadTitleGroup: { flex: 1, gap: 4 },
  toolName: { color: colors.text, fontSize: 16, lineHeight: 22, fontWeight: '800' },
  byteBadge: { color: colors.secondary, fontSize: 10, backgroundColor: colors.surfaceAlt, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4, overflow: 'hidden' },
  payloadHint: { color: colors.secondary, fontSize: 11, lineHeight: 17 },
  codeScroller: { maxHeight: 280, borderRadius: 13, backgroundColor: '#161616' },
  codeContent: { padding: 13 },
  codeText: { color: '#F2F2F2', fontFamily: 'monospace', fontSize: 12, lineHeight: 18 },
  noticeCard: { padding: 14, borderRadius: 16, backgroundColor: colors.surfaceAlt, gap: 5 },
  noticeTitle: { color: colors.text, fontSize: 12, fontWeight: '700', marginBottom: 2 },
  noticeText: { color: colors.secondary, fontSize: 11, lineHeight: 17 },
  footer: { paddingTop: 12, paddingHorizontal: 12, backgroundColor: colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, flexDirection: 'row', gap: 8 },
  cancelButton: { minHeight: 46, paddingHorizontal: 10, borderRadius: 14, backgroundColor: colors.dangerBackground, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },
  cancelButtonText: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  denyButton: { flex: 1, minHeight: 46, paddingHorizontal: 9, borderRadius: 14, backgroundColor: colors.surfaceAlt, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },
  denyButtonText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  approveButton: { flex: 1, minHeight: 46, paddingHorizontal: 9, borderRadius: 14, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },
  approveButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  actionDisabled: { opacity: 0.55 },
});
