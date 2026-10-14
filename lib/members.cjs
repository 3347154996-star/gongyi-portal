'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ACCOUNT = /^[A-Za-z0-9._-]{1,100}$/;
const ROLES = new Set(['member', 'reviewer', 'admin']);
const HASH = /^[a-f0-9]{128}$/;
const SALT = /^[a-f0-9]{32,128}$/;
const MAX_BYTES = 2 * 1024 * 1024;

class MemberStoreError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'MemberStoreError';
    this.status = status;
  }
}

function normalizeAccount(value) {
  if (typeof value !== 'string' || !ACCOUNT.test(value.trim())) {
    throw new MemberStoreError('工号需为 1–100 位数字、字母、点、下划线或短横线。');
  }
  return value.trim();
}

function validateName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new MemberStoreError('请填写不超过 100 字的成员姓名。');
  }
  return value.trim();
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 500) {
    throw new MemberStoreError('新密码需为 8–500 个字符。');
  }
  return value;
}

function publicMember(member) {
  return member ? {
    account: member.account,
    name: member.name,
    role: member.role,
    active: member.active,
    version: member.version
  } : null;
}

function passwordFields(password) {
  const salt = crypto.randomBytes(24).toString('hex');
  return { salt, passwordHash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function passwordMatches(member, password) {
  const digest = crypto.scryptSync(password, member.salt, 64);
  return crypto.timingSafeEqual(digest, Buffer.from(member.passwordHash, 'hex'));
}

function createMemberStore({ root, admin, now = Date.now } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof now !== 'function') {
    throw new MemberStoreError('成员存储目录或时钟配置不正确。', 503);
  }
  const directory = path.join(root, 'runtime');
  const filename = path.join(directory, 'members.json');
  let fileSeen = false;
  let bootstrap = null;
  if (admin != null) {
    try {
      bootstrap = {
        account: normalizeAccount(admin.username),
        name: validateName(admin.name || admin.username),
        role: 'admin',
        active: true,
        version: 1,
        salt: admin.salt,
        passwordHash: admin.passwordHash
      };
      if (!SALT.test(bootstrap.salt || '') || !HASH.test(bootstrap.passwordHash || '')) throw new Error();
    } catch (_) {
      throw new MemberStoreError('初始管理员配置不完整，请由维护人员核对。', 503);
    }
  }
  const dummy = { salt: crypto.randomBytes(24).toString('hex'), passwordHash: '0'.repeat(128) };
  const unavailable = () => new MemberStoreError('成员名单无法读取或已损坏，请由维护人员恢复，暂不接受登录或修改。', 503);

  function readState() {
    let state;
    try {
      const stat = fs.statSync(filename);
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error();
      state = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
      fileSeen = true;
    } catch (error) {
      if (error.code === 'ENOENT' && !fileSeen) {
        return { schemaVersion: 1, bootstrapAccount: bootstrap?.account || null, members: bootstrap ? [{ ...bootstrap }] : [], updatedAt: null };
      }
      throw unavailable();
    }
    try {
      if (!state || state.schemaVersion !== 1 || !Array.isArray(state.members) || state.members.length > 10000 ||
          !(state.bootstrapAccount === null || typeof state.bootstrapAccount === 'string') ||
          !Number.isFinite(state.updatedAt)) throw new Error();
      const seen = new Set();
      for (const member of state.members) {
        if (!member || normalizeAccount(member.account) !== member.account || validateName(member.name) !== member.name ||
            !ROLES.has(member.role) || typeof member.active !== 'boolean' ||
            !Number.isSafeInteger(member.version) || member.version < 1 ||
            typeof member.salt !== 'string' || !SALT.test(member.salt) ||
            typeof member.passwordHash !== 'string' || !HASH.test(member.passwordHash) ||
            seen.has(member.account) || Object.hasOwn(member, 'password')) throw new Error();
        seen.add(member.account);
      }
      if (!state.members.some(member => member.active && member.role === 'admin')) throw new Error();
      if (state.bootstrapAccount !== null && !seen.has(state.bootstrapAccount)) throw new Error();
      if (bootstrap && state.bootstrapAccount !== bootstrap.account) throw new Error();
      return state;
    } catch (_) {
      throw unavailable();
    }
  }

  function persist(state) {
    const updatedAt = now();
    if (!Number.isFinite(updatedAt)) throw new MemberStoreError('成员存储时钟不正确。', 503);
    const serialized = JSON.stringify({ ...state, updatedAt });
    if (Buffer.byteLength(serialized) > MAX_BYTES) throw new MemberStoreError('成员名单超过允许的容量。', 400);
    let descriptor;
    const temporary = path.join(directory, `.members-${crypto.randomUUID()}.tmp`);
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, serialized, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, filename);
      fileSeen = true;
    } catch (_) {
      throw new MemberStoreError('成员名单未能保存，修改未生效，请稍后重试。', 503);
    } finally {
      if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch (_) {}
      try { fs.unlinkSync(temporary); } catch (_) {}
    }
  }

  function get(account) {
    const state = readState();
    let normalized;
    try { normalized = normalizeAccount(account); } catch (_) { return null; }
    return publicMember(state.members.find(member => member.account === normalized));
  }

  function list() {
    return readState().members.map(publicMember).sort((a, b) => a.account.localeCompare(b.account, 'en'));
  }

  function authenticate(account, password) {
    const state = readState();
    let normalized;
    try { normalized = normalizeAccount(account); } catch (_) { return null; }
    if (typeof password !== 'string' || !password || password.length > 500) return null;
    const member = state.members.find(item => item.account === normalized);
    const matches = passwordMatches(member || dummy, password);
    return member && member.active && matches ? publicMember(member) : null;
  }

  function save(input, actor) {
    const state = readState();
    const currentActor = actor && state.members.find(member => member.account === actor.account);
    if (!currentActor || !currentActor.active || currentActor.role !== 'admin' || currentActor.version !== actor.version) {
      throw new MemberStoreError('仅当前有效的管理员可以维护成员名单。', 403);
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MemberStoreError('成员信息格式不正确。');
    const account = normalizeAccount(input.account), name = validateName(input.name);
    if (!ROLES.has(input.role) || typeof input.active !== 'boolean') throw new MemberStoreError('请选择有效的成员角色和启用状态。');
    const index = state.members.findIndex(member => member.account === account);
    const prior = index >= 0 ? state.members[index] : null;
    // Callers may use createOnly to distinguish an explicit new-member form from an edit.
    if (prior && input.createOnly === true) throw new MemberStoreError('该工号已存在，请编辑现有成员。', 409);
    if (input.version !== undefined && (!prior || input.version !== prior.version)) {
      throw new MemberStoreError('成员资料已经变更，请刷新后再修改。', 409);
    }
    if (account === currentActor.account && (!input.active || input.role !== 'admin')) {
      throw new MemberStoreError('管理员不能停用自己或降低自己的权限。', 409);
    }
    if (account === state.bootstrapAccount && (!input.active || input.role !== 'admin' || input.password !== undefined)) {
      throw new MemberStoreError('初始管理员不可由成员维护覆盖；请使用本人修改密码功能。', 409);
    }
    let secrets;
    if (input.password !== undefined) secrets = passwordFields(validatePassword(input.password));
    else if (prior) secrets = { salt: prior.salt, passwordHash: prior.passwordHash };
    else throw new MemberStoreError('新增成员时必须设置初始密码。');
    const changed = !prior || prior.name !== name || prior.role !== input.role || prior.active !== input.active || input.password !== undefined;
    if (!changed) return publicMember(prior);
    if (prior && prior.version === Number.MAX_SAFE_INTEGER) throw new MemberStoreError('成员版本已超出范围，请联系维护人员。', 503);
    const next = { account, name, role: input.role, active: input.active, version: prior ? prior.version + 1 : 1, ...secrets };
    if (index >= 0) state.members[index] = next;
    else state.members.push(next);
    if (!state.members.some(member => member.active && member.role === 'admin')) {
      throw new MemberStoreError('必须至少保留一名启用的管理员。', 409);
    }
    persist(state);
    return publicMember(next);
  }

  function changePassword(account, oldPassword, newPassword) {
    const state = readState();
    let normalized;
    try { normalized = normalizeAccount(account); } catch (_) { throw new MemberStoreError('账号或原密码不正确。', 401); }
    const member = state.members.find(item => item.account === normalized);
    if (typeof oldPassword !== 'string' || !oldPassword || oldPassword.length > 500 ||
        !passwordMatches(member || dummy, oldPassword) || !member?.active) {
      throw new MemberStoreError('账号或原密码不正确。', 401);
    }
    validatePassword(newPassword);
    if (oldPassword === newPassword) throw new MemberStoreError('新密码不能与原密码相同。');
    if (member.version === Number.MAX_SAFE_INTEGER) throw new MemberStoreError('成员版本已超出范围，请联系维护人员。', 503);
    Object.assign(member, passwordFields(newPassword), { version: member.version + 1 });
    persist(state);
    return publicMember(member);
  }

  readState();
  return Object.freeze({ authenticate, get, list, save, changePassword });
}

module.exports = { createMemberStore, MemberStoreError };
