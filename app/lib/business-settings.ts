import {DomainError} from './domain.ts';
export interface BusinessSettings {version:number;urgentDays:number;warningDays:number;}
const defaults:BusinessSettings={version:0,urgentDays:2,warningDays:5};
export function validateBusinessSettings(value:unknown):BusinessSettings {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new DomainError('业务规则格式无效',400);
  const input=value as Record<string,unknown>;
  if(Object.keys(input).some(key=>!['version','urgentDays','warningDays'].includes(key))||!Number.isSafeInteger(input.version)||Number(input.version)<0||!Number.isInteger(input.urgentDays)||!Number.isInteger(input.warningDays)||Number(input.urgentDays)<1||Number(input.urgentDays)>=Number(input.warningDays)||Number(input.warningDays)>30)throw new DomainError('紧急天数须小于预警天数，范围为1至30天',400);
  return {version:Number(input.version),urgentDays:Number(input.urgentDays),warningDays:Number(input.warningDays)};
}
export function createBusinessSettingsStore(environment:{DB?:D1Database}){
  function database():D1Database{if(!environment.DB)throw new DomainError('业务规则数据库暂时不可用',503);return environment.DB;}
  return {
    async read(userId:string):Promise<BusinessSettings>{
      const row=await database().prepare('SELECT version,data_json FROM workbench_business_settings WHERE user_id = ?').bind(userId).first<{version:number;data_json:string}>();
      return row?validateBusinessSettings({...JSON.parse(row.data_json),version:row.version}):{...defaults};
    },
    async save(userId:string,value:unknown):Promise<BusinessSettings>{
      const input=validateBusinessSettings(value),next={...input,version:input.version+1};const now=new Date().toISOString();
      if(input.version===0){
        try{await database().prepare('INSERT INTO workbench_business_settings (user_id,version,updated_at,data_json) VALUES (?,?,?,?)').bind(userId,next.version,now,JSON.stringify(next)).run();}catch(error){if(/UNIQUE|constraint/i.test(error instanceof Error?error.message:''))throw new DomainError('业务规则已更新，请刷新后重试',409);throw error;}
      }else{
        const result=await database().prepare('UPDATE workbench_business_settings SET version = ?,updated_at = ?,data_json = ? WHERE user_id = ? AND version = ?').bind(next.version,now,JSON.stringify(next),userId,input.version).run();
        if(result.meta.changes!==1)throw new DomainError('业务规则已更新，请刷新后重试',409);
      }
      return next;
    }
  };
}
