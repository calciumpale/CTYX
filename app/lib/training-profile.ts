export interface TrainingProfile {
  name:string;
  industry:string;
  role:string;
  need:string;
  budget:string;
  timeline:string;
  decisionMode:'本人决策'|'与合伙人共同决策'|'需上级审批';
  communicationStyle:'直接干脆'|'谨慎细致'|'健谈随和'|'强势质疑';
  concern:string;
  difficulty:'入门'|'进阶'|'挑战';
}

export const trainingProfileLimits:Record<keyof TrainingProfile,number>={name:60,industry:100,role:100,need:600,budget:160,timeline:160,decisionMode:40,communicationStyle:40,concern:600,difficulty:20};
const labels:Record<keyof TrainingProfile,string>={name:'客户称呼',industry:'行业',role:'客户角色',need:'核心需求',budget:'预算',timeline:'时间计划',decisionMode:'决策方式',communicationStyle:'沟通风格',concern:'主要顾虑',difficulty:'训练难度'};
const choices={decisionMode:['本人决策','与合伙人共同决策','需上级审批'],communicationStyle:['直接干脆','谨慎细致','健谈随和','强势质疑'],difficulty:['入门','进阶','挑战']};

/** Shared, side-effect-free parsing. Only the ten confirmed persona fields persist. */
export function validateTrainingProfile(value:unknown):TrainingProfile {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('请完整填写并确认客户画像');
  const source=value as Record<string,unknown>;const result:Record<string,string>={};
  for(const field of Object.keys(trainingProfileLimits) as (keyof TrainingProfile)[]) {
    const entry=source[field];
    if(typeof entry!=='string'||!entry.trim())throw new TypeError(`请填写${labels[field]}`);
    if(entry.length>trainingProfileLimits[field])throw new TypeError(`${labels[field]}不能超过${trainingProfileLimits[field]}字`);
    const normalized=entry.trim();
    if(field in choices&&!(choices[field as keyof typeof choices] as readonly string[]).includes(normalized))throw new TypeError(`${labels[field]}选项不正确`);
    result[field]=normalized;
  }
  return result as unknown as TrainingProfile;
}

export function defaultTrainingProfile(scenario:string):TrainingProfile {
  if(/竞品|比较/.test(scenario))return {name:'许总',industry:'数字创意',role:'公司负责人',need:'约300平方米办公空间，重视通勤和配套',budget:'月租预算3万元以内，需要比较全部费用',timeline:'三个月内搬迁，期望一个月内确定选址',decisionMode:'本人决策',communicationStyle:'直接干脆',concern:'隔壁园区报价更低，两边总成本和交付标准是否可比',difficulty:'进阶'};
  if(/首访|首次|拜访|需求|决策/.test(scenario))return {name:'周女士',industry:'软件服务',role:'行政负责人',need:'为30人团队寻找约400平方米的新办公地点，可灵活扩容',budget:'月租预算4万元以内，需汇总物业及搬迁成本',timeline:'四个月内搬迁，希望本月完成首轮看房',decisionMode:'需上级审批',communicationStyle:'健谈随和',concern:'新办公地点的面积、通勤和交付时间能否符合团队需求',difficulty:'入门'};
  return {name:'陈总',industry:'精品咖啡',role:'联合创始人',need:'约100平方米临街商铺，便于外带并能满足装修要求',budget:'月租预算2万元以内，控制开业前总投入',timeline:'两个月后开业，装修预计45天',decisionMode:'与合伙人共同决策',communicationStyle:'谨慎细致',concern:'装修期间的租金支出，以及交付延期影响开业',difficulty:'进阶'};
}
