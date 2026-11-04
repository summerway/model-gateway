import { readFileSync, existsSync } from 'node:fs';
import { atomic, backupConfig } from '../config-file.js';
import { join, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { parseYaml } from '../yaml.js';
import { validateConfig, resolveRef } from '../config.js';
import { sendMail } from './notify.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprint = item => hash(JSON.stringify([item.old,item.model,item.info,item.oldinfo,item.evidence,item.reason]));
const active = item => ['pending', 'failed'].includes(item.status);
const mid = m => typeof m === 'string' ? m : m.id;
const parse = text => { try { return JSON.parse(text); } catch { return parseYaml(text); } };
export class InboxError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}

/** Only the selected provider's models block is edited; unknown YAML forms fail closed.
 *  replace 的替换目标：item.old（升级）或同渠道第一个非 monitor 模型（新系列替换参照，
 *  与控制台参照口径一致）。 */
export function editModels(text, item, action) {
  const raw = parse(text);
  const provider = raw.providers?.find(p => p.id === item.providerId);
  if (!provider) throw new InboxError('目标渠道已不存在，请重新巡检');
  const oldId = item.old
    ?? (action === 'replace' ? provider.models.filter(m => !m.monitor).map(mid).find(id => id !== item.model) : undefined);
  if (action === 'replace' && oldId == null) throw new InboxError('没有可替换的参照模型', 400);
  const ids = provider.models.map(mid);
  if (action !== 'add' && !ids.includes(oldId)) throw new InboxError('当前模型已改变，请重新巡检');
  if (action !== 'remove' && ids.includes(item.model)) throw new InboxError('候选模型已在目录中');
  if (action !== 'add' && (raw.imageGeneration?.model === oldId || raw.providers.some(p => Object.entries(p.fallbackModelMap ?? {}).some(([k,v]) => k === oldId || v === oldId)))) {
    throw new InboxError('旧模型仍被默认模型或备用映射引用，请先处理关联配置');
  }
  provider.models = action === 'add' ? [...provider.models, item.model] : provider.models.flatMap(m => mid(m) !== oldId ? [m] : action === 'remove' ? [] : [typeof m === 'string' ? item.model : { ...m, id: item.model }]);
  validateConfig(raw);
  try { JSON.parse(text); return JSON.stringify(raw, null, 2) + '\n'; } catch {}
  const lines = text.split('\n');
  const start = lines.findIndex(l => /^providers:\s*(?:#.*)?$/.test(l));
  if (start < 0) throw new InboxError('此 YAML 结构不支持安全编辑，请手动修改');
  let end = lines.findIndex((l,i) => i > start && /^\S/.test(l) && !l.startsWith('#'));
  if (end < 0) end = lines.length;
  const candidates = lines.map((l,i) => ({ i, indent: l.search(/\S/), match: /^\s*-\s+id:/.test(l) })).filter(x => x.i > start && x.i < end && x.match);
  const indent = Math.min(...candidates.map(x => x.indent));
  const starts = candidates.filter(x => x.indent === indent).map(x => x.i);
  let a = -1, b = end;
  for (let i = 0; i < starts.length; i++) {
    const tail = starts[i + 1] ?? end;
    if (parseYaml('providers:\n' + lines.slice(starts[i],tail).join('\n')).providers?.[0]?.id === item.providerId) { a = starts[i]; b = tail; break; }
  }
  if (a < 0) throw new InboxError('无法安全定位渠道');
  const key = lines.findIndex((l,i) => i > a && i < b && /^\s+models:\s*(?:#.*)?$/.test(l));
  if (key < 0) throw new InboxError('请将 models 改为多行列表后重试');
  const keyIndent = lines[key].search(/\S/);
  let stop = key + 1;
  while (stop < b && (!lines[stop].trim() || lines[stop].trim().startsWith('#') || lines[stop].search(/\S/) > keyIndent)) stop++;
  const entries = [];
  for (let i = key + 1; i < stop; i++) if (new RegExp(`^ {${keyIndent + 2}}- `).test(lines[i])) entries.push(i);
  const original = parse(text).providers.find(p => p.id === item.providerId).models;
  if (entries.length !== original.length) throw new InboxError('模型列表缩进不受支持，请手动修改');
  if (action === 'add') lines.splice(stop,0,' '.repeat(keyIndent + 2) + '- ' + item.model);
  else {
    const index = original.findIndex(m => mid(m) === oldId);
    const line = entries[index];
    if (action === 'remove') lines.splice(line,(entries[index + 1] ?? stop) - line);
    else lines[line] = lines[line].replace(/^(\s*-\s*(?:id:\s*)?)(?:"[^"]*"|'[^']*'|[^#]*?)(\s*(?:#.*)?)$/, (_,prefix,suffix) => prefix + item.model + suffix);
  }
  const result = lines.join('\n');
  validateConfig(parse(result));
  if (JSON.stringify(parse(result).providers) !== JSON.stringify(raw.providers)) throw new InboxError('安全编辑校验失败');
  return result;
}

export class ModelInbox {
  constructor({ file, configPath, onChange, events, notifyCfg, publicUrl, now = Date.now, mail = sendMail, validateModel, metadataFor } = {}) {
    Object.assign(this, { file, configPath, onChange, events, notifyCfg, publicUrl, now, mail, validateModel, metadataFor });
    this.items = [];
    this.csrf = randomBytes(24).toString('hex');
    this.previews = new Map();
    this.queue = Promise.resolve();
    if (file && existsSync(file)) {
      try {
        const state = JSON.parse(readFileSync(file,'utf8'));
        if (!Array.isArray(state.items) || state.items.some(i => !i || !/^[a-f0-9]{64}$/.test(i.id) || typeof i.providerId !== 'string' || typeof i.model !== 'string' || !Number.isFinite(Date.parse(i.firstSeen)))) throw new Error('Inbox state invalid');
        this.items = state.items;
        let recovered = false;
        for (const item of this.items) if (item.status === 'processing') {
          const applied = hash(readFileSync(configPath,'utf8')) === item.operation?.after;
          item.status = applied ? item.operation.result : 'failed';
          item.error = applied ? null : '执行被中断，需重新预览配置';
          if (applied) this.events?.record('model_inbox_applied',{recovered:true,providerId:item.providerId,model:item.model,action:item.operation.result});
          recovered = true;
        }
        if (recovered) this.save();
      } catch { this.loadError = true; }
    }
  }
  serial(fn) { const next = this.queue.then(fn); this.queue = next.catch(() => {}); return next; }
  save() { if (this.loadError) throw new InboxError('收件箱状态无法读取，请修复状态文件后重启',503); if (this.file) atomic(this.file, JSON.stringify({ version:1,items: this.items },null,2) + '\n'); }
  snapshot(summary = false) {
    if (this.loadError) throw new InboxError('收件箱状态无法读取，请修复状态文件后重启',503);
    return { pending: this.items.filter(active).length, csrf: this.csrf, ...(summary ? {} : { items: this.items.map(({ operation, ...item }) => item).sort((a,b) => b.firstSeen.localeCompare(a.firstSeen)), rollback: this.lastApplied() }) };
  }
  async reconcile(candidates) {
    return this.serial(async () => {
      const previous = structuredClone(this.items);
      const seen = new Set(); const at = new Date(this.now()).toISOString();
      for (const c of candidates) {
        const id = hash(JSON.stringify([c.providerId,c.kind,c.model]));
        seen.add(id);
        let item = this.items.find(x => x.id === id);
        if (!item) { item = { ...c, id, status:'pending', firstSeen:at, read:false }; this.items.push(item); }
        else if (active(item) || item.status === 'expired') { Object.assign(item,c); if (item.status === 'expired') item.status = 'pending'; }
        item.lastSeen = at;
      }
      for (const item of this.items) if (active(item) && !seen.has(item.id)) item.status = 'expired';
      try { this.save(); }
      catch (error) {
        this.items = previous;
        this.events?.record('model_inbox_error',{stage:'persist',message:'模型待办保存失败，保留上次持久化状态'});
        throw error;
      }
      await this.notify();
    });
  }
  async notify() {
    if (!this.notifyCfg?.smtpUrl) return;
    const due = this.items.filter(i => active(i) && i.notified !== (i.failureId ?? 'new') && (i.notifyAfter ?? 0) <= this.now());
    if (!due.length) return;
    const smtpUrl = resolveRef(this.notifyCfg.smtpUrl);
    if (!smtpUrl) return;
    let ok = false;
    try {
      if (!this.publicUrl) throw new Error('请配置 modelInbox.publicUrl 以提供收件箱链接');
      const result = await this.mail({ ...this.notifyCfg, smtpUrl }, { subject:`[model-gateway] ${due.length} 项模型待办`, text:due.map(i => `${i.status === 'failed' ? '处理失败' : i.kind === 'retire' ? '疑似退役' : '发现升级建议'}：${i.providerId} / ${i.old && i.old !== i.model ? i.old + ' → ' : ''}${i.model}\n${i.error ?? i.reason ?? '等待人工处理'}\n${new URL('/#gateway-suggestions',this.publicUrl).href}`).join('\n\n') + '\n当前配置以页面显示为准；新建议尚未执行。' });
      ok = result?.ok === true;
    } catch {}
    for (const item of due) { if (ok) item.notified = item.failureId ?? 'new'; else item.notifyAfter = this.now() + 3600000; }
    if (!ok) this.events?.record('model_inbox_notify_error', { message:'待办已保存，摘要邮件未发送；请检查 SMTP 和 modelInbox.publicUrl' });
    this.save();
  }
  preview(id, action) {
    const item = this.items.find(i => i.id === id);
    if (!item || !active(item)) throw new InboxError('此待办不可操作');
    const allowed = item.kind === 'retire' ? ['remove','dismiss'] : ['add','replace','dismiss'];
    if (!allowed.includes(action)) throw new InboxError('无效操作',400);
    if (['add','replace'].includes(action) && this.validateModel && !this.validateModel(item.model)) throw new InboxError('模型目录尚未确认此候选，请待目录更新后重试');
    const before = readFileSync(this.configPath,'utf8');
    const after = action === 'dismiss' ? before : editModels(before,item,action);
    const token = randomBytes(24).toString('hex');
    for (const [key,p] of this.previews) if (p.expires < this.now()) this.previews.delete(key);
    if (this.previews.size >= 64) this.previews.delete(this.previews.keys().next().value);
    const metadata = this.metadataFor ? {old:this.metadataFor(item.old),model:this.metadataFor(item.model)} : null;
    this.previews.set(token,{ id,action,before:hash(before),after,expires:this.now()+600000, candidate:fingerprint(item),metadata:JSON.stringify(metadata) });
    const oldModels = parse(before).providers.find(p => p.id === item.providerId)?.models.map(mid);
    const newModels = parse(after).providers.find(p => p.id === item.providerId)?.models.map(mid);
    return { token, providerId:item.providerId, action, before:oldModels, after:newModels,prices:{old:metadata?.old?.cost ?? item.oldinfo?.cost ?? null,model:metadata?.model?.cost ?? item.info?.cost ?? null} };
  }
  async apply(token) {
    return this.serial(async () => {
      const p = this.previews.get(token);
      if (!p || p.expires < this.now()) throw new InboxError('预览已失效，请重新预览');
      const item = this.items.find(i => i.id === p.id);
      if (!item || !active(item) || fingerprint(item) !== p.candidate) throw new InboxError('候选已改变，请重新预览');
      if (['add','replace'].includes(p.action) && this.validateModel && !this.validateModel(item.model)) throw new InboxError('候选已不在模型目录，请重新巡检');
      const metadata = this.metadataFor ? {old:this.metadataFor(item.old),model:this.metadataFor(item.model)} : null;
      if (JSON.stringify(metadata) !== p.metadata) throw new InboxError('价格或模型能力已更新，请重新预览');
      const before = readFileSync(this.configPath,'utf8');
      if (hash(before) !== p.before) throw new InboxError('配置已改变，请重新预览');
      const result = { add:'added',replace:'replaced',remove:'removed',dismiss:'dismissed' }[p.action];
      if (p.action === 'dismiss') { const previous = {status:item.status,handledAt:item.handledAt}; item.status = result; item.handledAt = new Date(this.now()).toISOString(); try { this.save(); } catch { item.status = previous.status; if (previous.handledAt === undefined) delete item.handledAt; else item.handledAt = previous.handledAt; throw new InboxError('待办保存失败，请稍后重试',500); } this.previews.delete(token); return this.snapshot(); }
      item.status = 'processing'; item.operation = { before:p.before,after:hash(p.after),result }; try { this.save(); } catch { item.status='failed'; throw new InboxError('待办保存失败，配置未修改',500); }
      try {
        const backupFile = backupConfig(this.file, before, this.now());
        item.operation.backup = backupFile;
        atomic(this.configPath,p.after);
        if (await this.onChange?.() === false) throw new Error('热加载失败');
        item.status = result; item.error = null; item.handledAt = new Date(this.now()).toISOString();
        this.save();
        this.events?.record('model_inbox_applied',{ providerId:item.providerId,action:p.action,model:item.model,old:item.old,backup:backupFile });
        this.previews.delete(token);
      } catch (err) {
        try { if (hash(readFileSync(this.configPath,'utf8')) === hash(p.after)) { atomic(this.configPath,before); await this.onChange?.(); } } catch {}
        item.status = 'failed'; item.failedAt = new Date(this.now()).toISOString();
        item.error = err && (err.code === 'EROFS' || err.code === 'EACCES')
          ? '配置目录只读（生产 compose 将 config 卷挂为只读），落地被阻断；需将 config 挂载改为可写后重试'
          : '配置变更未完成，已尝试恢复旧配置；请重新预览后重试';
        item.failureId = randomBytes(8).toString('hex');
        try { this.save(); await this.notify(); } catch { this.events?.record('model_inbox_error',{stage:'persist'}); }
        throw new InboxError(item.error,500);
      }
      return this.snapshot();
    });
  }

  /** 最近一次成功落地（供 UI 展示「回滚最近落地」）；无可回滚返回 null。 */
  lastApplied() {
    const items = this.items.filter(i => i.operation?.backup && ['added','replaced','removed'].includes(i.status))
      .sort((a,b) => (b.handledAt ?? '').localeCompare(a.handledAt ?? ''));
    const i = items[0];
    if (!i) return null;
    return { id:i.id, providerId:i.providerId, action:i.status, model:i.model, old:i.old ?? null,
      at:i.handledAt, backup:i.operation.backup, canRollback: hash(readFileSync(this.configPath,'utf8')) === i.operation.after };
  }

  /** 回滚最近一次落地：备份文本写回 config + 热加载；条目标记 rolledBackAt（保持已处理态，不重复提醒）。 */
  async rollback() {
    return this.serial(async () => {
      const last = this.lastApplied();
      if (!last) throw new InboxError('没有可回滚的落地动作');
      if (!last.canRollback) throw new InboxError('配置在落地后被其他方式修改，自动回滚不安全；请用备份文件人工处理',409);
      const item = this.items.find(i => i.id === last.id);
      const backupText = readFileSync(join(dirname(this.file), last.backup), 'utf8');
      atomic(this.configPath, backupText);
      if (await this.onChange?.() === false) throw new InboxError('回滚已写入但热加载失败，请检查网关日志',500);
      if (item) { item.rolledBackAt = new Date(this.now()).toISOString(); item.operation = null; try { this.save(); } catch {} }
      this.events?.record('model_inbox_rollback', { providerId:last.providerId, action:last.action, model:last.model, old:last.old, backup:last.backup });
      return this.snapshot();
    });
  }
}
