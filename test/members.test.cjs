'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { makeAdminConfig } = require('../lib/admin.cjs');
const { createMemberStore, MemberStoreError } = require('../lib/members.cjs');

const ADMIN_PASSWORD = 'synthetic-admin-password';
const MEMBER_PASSWORD = 'synthetic-member-password';
function fixture(t, options = {}) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'portal-members-test-'));
  t.after(() => {
    if (path.dirname(root) !== temporaryRoot || !path.basename(root).startsWith('portal-members-test-')) throw new Error('Unexpected temporary cleanup path');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const admin = makeAdminConfig('00001', ADMIN_PASSWORD);
  const store = createMemberStore({ root, admin, now: () => 1780000000000, ...options });
  return { root, admin, store, file: path.join(root, 'runtime', 'members.json'), actor: store.authenticate('00001', ADMIN_PASSWORD) };
}
function memberInput(overrides = {}) {
  return { account: '00123', name: '测试成员', role: 'member', active: true, password: MEMBER_PASSWORD, ...overrides };
}
function hasStatus(status) {
  return error => error instanceof MemberStoreError && error.status === status;
}

test('bootstrap uses the existing admin hash and never returns password material', t => {
  const { store, actor } = fixture(t);
  assert.deepEqual(actor, { account: '00001', name: '00001', role: 'admin', active: true, version: 1 });
  assert.equal(store.authenticate('00001', 'wrong-password'), null);
  assert.equal(store.authenticate('unknown', ADMIN_PASSWORD), null);
  assert.equal(store.authenticate(1, ADMIN_PASSWORD), null);
  assert.deepEqual(Object.keys(store.get('00001')).sort(), ['account', 'active', 'name', 'role', 'version']);
  const copy = store.get('00001'); copy.role = 'member';
  assert.equal(store.get('00001').role, 'admin');
});

test('member creation preserves leading zeroes, persists only salted hashes, and survives restart', t => {
  const { store, actor, file, root, admin } = fixture(t);
  const saved = store.save(memberInput(), actor);
  assert.deepEqual(saved, { account: '00123', name: '测试成员', role: 'member', active: true, version: 1 });
  const serialized = fs.readFileSync(file, 'utf8');
  assert.equal(serialized.includes(MEMBER_PASSWORD), false);
  assert.equal(serialized.includes(ADMIN_PASSWORD), false);
  const document = JSON.parse(serialized);
  assert.equal(document.updatedAt, 1780000000000);
  assert.notEqual(document.members[0].salt, document.members[1].salt);
  assert.equal(document.members.some(member => Object.hasOwn(member, 'password')), false);
  const restored = createMemberStore({ root, admin });
  assert.deepEqual(restored.authenticate('00123', MEMBER_PASSWORD), saved);
  assert.equal(restored.authenticate('123', MEMBER_PASSWORD), null);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['members.json']);
});

test('invalid member inputs are rejected before any durable changes', t => {
  const { store, actor, file } = fixture(t);
  for (const override of [
    { account: 123 }, { account: '../1' }, { account: '工号1' }, { account: 'a'.repeat(101) },
    { name: '' }, { name: 'bad\nname' }, { role: 'owner' }, { active: 'true' },
    { password: 'short' }, { password: 'x'.repeat(501) }, { password: undefined }
  ]) assert.throws(() => store.save(memberInput(override), actor), hasStatus(400));
  assert.equal(fs.existsSync(file), false);
  assert.equal(store.list().length, 1);
});

test('only a current active administrator can maintain the whitelist', t => {
  const { store, actor } = fixture(t);
  const member = store.save(memberInput(), actor);
  const reviewer = store.save(memberInput({ account: '00200', role: 'reviewer' }), actor);
  for (const attemptedActor of [null, member, reviewer, { ...member, role: 'admin' }, { account: 'missing', role: 'admin', version: 1 }, { ...actor, version: 99 }]) {
    assert.throws(() => store.save(memberInput({ account: '00300' }), attemptedActor), hasStatus(403));
  }
  assert.equal(store.get('00300'), null);
});

test('explicit create rejects duplicate accounts and updates preserve a single record', t => {
  const { store, actor } = fixture(t);
  const first = store.save(memberInput(), actor);
  assert.throws(() => store.save(memberInput({ createOnly: true }), actor), hasStatus(409));
  const edited = store.save({ account: first.account, name: '更新姓名', role: 'reviewer', active: true, version: first.version }, actor);
  assert.equal(edited.version, 2);
  assert.equal(store.list().filter(member => member.account === first.account).length, 1);
  assert.equal(store.authenticate(first.account, MEMBER_PASSWORD).role, 'reviewer');
  assert.throws(() => store.save({ ...edited, name: '过期修改', version: first.version }, actor), hasStatus(409));
  assert.equal(store.get(first.account).name, '更新姓名');
  assert.equal(store.save(edited, actor).version, 2);
});

test('disabling a member invalidates login and increments the version observed by other stores', t => {
  const { store, actor, root, admin } = fixture(t);
  const member = store.save(memberInput(), actor);
  const observer = createMemberStore({ root, admin });
  const disabled = store.save({ ...member, active: false }, actor);
  assert.equal(disabled.version, member.version + 1);
  assert.equal(observer.get(member.account).active, false);
  assert.equal(observer.authenticate(member.account, MEMBER_PASSWORD), null);
  assert.throws(() => observer.changePassword(member.account, MEMBER_PASSWORD, 'synthetic-new-password'), hasStatus(401));
  const restored = store.save({ ...disabled, active: true }, actor);
  assert.equal(restored.version, 3);
  assert.equal(observer.authenticate(member.account, MEMBER_PASSWORD).version, 3);
});

test('password changes verify the old password, rotate hashes, and invalidate prior versions', t => {
  const { store, actor, file } = fixture(t);
  const member = store.save(memberInput(), actor);
  const previous = fs.readFileSync(file, 'utf8');
  assert.throws(() => store.changePassword(member.account, 'wrong-password', 'synthetic-new-password'), hasStatus(401));
  assert.throws(() => store.changePassword(member.account, MEMBER_PASSWORD, 'short'), hasStatus(400));
  assert.throws(() => store.changePassword(member.account, MEMBER_PASSWORD, MEMBER_PASSWORD), hasStatus(400));
  assert.equal(fs.readFileSync(file, 'utf8'), previous);
  const changed = store.changePassword(member.account, MEMBER_PASSWORD, 'synthetic-new-password');
  assert.equal(changed.version, member.version + 1);
  assert.equal(store.authenticate(member.account, MEMBER_PASSWORD), null);
  assert.equal(store.authenticate(member.account, 'synthetic-new-password').version, changed.version);
  assert.equal(fs.readFileSync(file, 'utf8').includes('synthetic-new-password'), false);
});

test('bootstrap cannot be overwritten through same-account creation and its old configured password never returns', t => {
  const { store, actor, root, admin } = fixture(t);
  assert.throws(() => store.save(memberInput({ account: actor.account, role: 'admin' }), actor), hasStatus(409));
  const renamed = store.save({ ...actor, name: '维护管理员' }, actor);
  assert.equal(renamed.version, 2);
  const changed = store.changePassword(actor.account, ADMIN_PASSWORD, 'synthetic-rotated-admin');
  assert.equal(changed.version, 3);
  assert.throws(() => store.save(memberInput(), actor), hasStatus(403));
  const restored = createMemberStore({ root, admin });
  assert.equal(restored.authenticate(actor.account, ADMIN_PASSWORD), null);
  assert.equal(restored.authenticate(actor.account, 'synthetic-rotated-admin').name, '维护管理员');
});

test('administrators cannot disable or demote themselves, including the last active administrator', t => {
  const { store, actor } = fixture(t);
  for (const changed of [{ ...actor, active: false }, { ...actor, role: 'member' }]) {
    assert.throws(() => store.save(changed, actor), hasStatus(409));
  }
  const second = store.save(memberInput({ account: '00200', role: 'admin' }), actor);
  assert.throws(() => store.save({ ...second, active: false }, second), hasStatus(409));
  const disabled = store.save({ ...second, active: false }, actor);
  assert.equal(disabled.active, false);
  assert.throws(() => store.save(memberInput({ account: '00300' }), second), hasStatus(403));
  assert.equal(store.list().filter(member => member.active && member.role === 'admin').length, 1);
});

test('corruption fails closed, including duplicate accounts and loss of the active administrator', t => {
  const { store, actor, file, root, admin } = fixture(t);
  store.save(memberInput(), actor);
  const good = fs.readFileSync(file, 'utf8');
  const malformed = JSON.parse(good);
  const duplicates = JSON.parse(good); duplicates.members.push({ ...duplicates.members[1] });
  const noAdmin = JSON.parse(good); noAdmin.members[0].active = false;
  const plaintext = JSON.parse(good); plaintext.members[1].password = 'forbidden';
  malformed.members[1].passwordHash = 'broken';
  for (const broken of ['{bad json', '{}', JSON.stringify(malformed), JSON.stringify(duplicates), JSON.stringify(noAdmin), JSON.stringify(plaintext)]) {
    fs.writeFileSync(file, broken);
    assert.throws(() => store.list(), hasStatus(503));
    assert.throws(() => store.authenticate(actor.account, ADMIN_PASSWORD), hasStatus(503));
    assert.throws(() => store.save(memberInput({ account: '00300' }), actor), hasStatus(503));
    assert.throws(() => createMemberStore({ root, admin }), hasStatus(503));
    assert.equal(fs.readFileSync(file, 'utf8'), broken);
  }
  fs.writeFileSync(file, good);
  assert.equal(store.list().length, 2);
  fs.unlinkSync(file);
  assert.throws(() => store.authenticate(actor.account, ADMIN_PASSWORD), hasStatus(503));
});

test('failed atomic replacement leaves the previous document intact and clears the temporary file', t => {
  const { store, actor, file } = fixture(t);
  store.save(memberInput(), actor);
  const prior = fs.readFileSync(file, 'utf8');
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('synthetic disk replacement failure'); };
  try {
    assert.throws(() => store.save(memberInput({ account: '00300' }), actor), hasStatus(503));
  } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(file, 'utf8'), prior);
  assert.equal(store.get('00300'), null);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['members.json']);
});

test('missing admin has no default login and malformed admin configuration is not silently ignored', t => {
  const { root } = fixture(t);
  const empty = createMemberStore({ root });
  assert.equal(empty.authenticate('admin', 'password'), null);
  assert.deepEqual(empty.list(), []);
  assert.throws(() => empty.save(memberInput(), { account: 'admin', role: 'admin', version: 1 }), hasStatus(403));
  assert.throws(() => createMemberStore({ root, admin: { username: 'admin' } }), hasStatus(503));
});
