'use strict';
const crypto=require('node:crypto');
function makeAdminConfig(username,password){
  if(typeof username!=='string'||!username.trim()||username.length>100||typeof password!=='string'||!password||password.length>500)throw new Error('请输入有效的管理员账号和密码。');
  const salt=crypto.randomBytes(24).toString('hex');
  return {username:username.trim(),salt,passwordHash:crypto.scryptSync(password,salt,64).toString('hex')};
}
function verifyAdmin(admin,username,password){
  if(!admin||typeof admin.username!=='string'||typeof admin.salt!=='string'||!/^[a-f0-9]{128}$/.test(admin.passwordHash||'')||typeof username!=='string'||typeof password!=='string'||password.length>500)return false;
  const calculated=crypto.scryptSync(password,admin.salt,64),expected=Buffer.from(admin.passwordHash,'hex');
  return crypto.timingSafeEqual(calculated,expected)&&username.trim()===admin.username;
}
module.exports={makeAdminConfig,verifyAdmin};
