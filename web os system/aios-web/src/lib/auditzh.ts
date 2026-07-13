// Traditional-Chinese labels for audit log action codes and entity names.
// Unknown codes fall back to the raw string so nothing is ever hidden.

const ACTION_ZH: Record<string, string> = {
  'user.registered': '使用者註冊',
  'user.role_changed': '變更使用者權限',
  'agent.created': '建立員工',
  'agent.updated': '更新員工',
  'agent.deleted': '刪除員工',
  'skill.created': '建立技能',
  'skill.confirmed': '技能已確認',
  'skill.rejected': '技能已拒絕',
  'skill.update': '更新技能',
  'conversation.create': '建立對話',
  'run.start': '執行開始',
  'run.finish': '執行結束',
  'account.connected': '帳號連動',
  'account.disconnected': '解除連動',
  'integration.arap_template_created': '建立AR/AP範本',
  'integration.sample_file_created': '建立範例檔案',
  'cloud.listChildren': '瀏覽雲端資料夾',
  'cloud.getFileMeta': '讀取檔案資訊',
  'cloud.downloadFile': '下載雲端檔案',
  'cloud.listMessages': '讀取郵件清單',
  'cloud.sendMail': '寄送郵件',
  'binding.created': '新增頻道綁定',
  'binding.deleted': '刪除頻道綁定',
  'workflow.created': '建立工作流',
  'workflow.create': '建立工作流',
  'workflow.updated': '更新工作流',
  'workflow.update': '更新工作流',
  'workflow.deleted': '刪除工作流',
  'workflow.delete': '刪除工作流',
  'workflow.steps_updated': '更新工作流步驟',
  'workflow.steps.replace': '更新工作流步驟',
  'workflow.run': '執行工作流',
  'workflow.test': '測試工作流',
  'agent.file_targets_replaced': '更新員工雲端檔案目標',
  'cloud.createSampleFile': '建立雲端範例檔案',
  'cloud.createSpreadsheet': '建立雲端試算表',
  'integration.connected': '帳號連動成功',
};

const ENTITY_ZH: Record<string, string> = {
  Agent: '員工',
  Skill: '技能',
  Workflow: '工作流',
  Run: '執行',
  User: '使用者',
  Conversation: '對話',
  CloudFileRef: '雲端檔案',
  ChannelBinding: '頻道綁定',
};

/** Traditional-Chinese label for an audit action code. Falls back to the raw code when unknown. */
export function auditZh(action: string): string {
  return ACTION_ZH[action] ?? action;
}

/** Traditional-Chinese label for an audit entity name. Falls back to the raw name when unknown. */
export function entityZh(entity: string): string {
  return ENTITY_ZH[entity] ?? entity;
}
