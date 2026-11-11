import { DATASET_ID, DEPARTMENTS } from './workspace-departments.ts';
import type { Deal, WorkbenchState } from './types.ts';

const stages = [
  { id: 'opportunity', stage: '商机', progress: '已初步确认需求和时间范围。', nextAction: '约业务负责人确认预算、决策流程和到访时间' },
  { id: 'proposal', stage: '方案', progress: '已提交初版方案，等待业务方反馈。', nextAction: '收集方案反馈，核对报价范围与交付排期' },
  { id: 'contract', stage: '合同', progress: '商务条件已对齐，合同草案正在会审。', nextAction: '与法务逐项核对验收标准、付款节点和责任边界' },
  { id: 'payment', stage: '回款', progress: '已模拟签约及首期验收，正在核对付款资料。', nextAction: '核对开票信息和首期付款节点，登记对账结果' },
] as const;
const exampleLabel = '【演示】';

type Scenario = readonly [company: string, project: string, need: string];
const scenarios: Record<typeof DEPARTMENTS[number]['username'], readonly [Scenario, Scenario, Scenario, Scenario]> = {
  zs: [
    ['晴屿咖啡社', '园区首店选址', '首层临街铺位，方便早间外带和团购取餐'],
    ['麦岸手作烘焙', '社区烘焙店开设', '核对后厨排烟、上下水和配送动线'],
    ['拾味盒餐饮', '办公园区快餐店租赁', '明确供电容量、装修期及交付标准'],
    ['稻穗里轻食', '轻食门店租赁', '约定首期租金、保证金及进场交接'],
  ],
  yl: [
    ['枝汀景观工作室', '邻里公园绿化改造', '保留现有乔木，补齐步道沿线遮阴'],
    ['栖叶园林社', '园区屋顶花园更新', '复核屋面荷载，比较植物搭配和灌溉方案'],
    ['石溪景观营造', '滨水绿道种植养护', '列明补植规格、成活率验收及养护周期'],
    ['禾径绿化服务', '办公园区绿化养护', '按月核对养护台账和阶段验收单'],
  ],
  ch: [
    ['原尺测绘工作室', '存量园区地形测量', '确定测区边界、测图比例尺和成果用途'],
    ['方隅空间测量', '厂区地下管线测绘', '提供管线点位、探测精度和成果图层'],
    ['经纬坪地理信息', '建设工程竣工测量', '明确成果格式、精度验收和补测责任'],
    ['叠图勘测服务', '园区地籍测量', '核对成果交付清单和分期验收记录'],
  ],
  yy: [
    ['澄湾医药研发', '研发用房需求核实', '确认研发工艺、通风条件和适用资质'],
    ['微栖医用耗材', '耗材周转库筹建', '比较存储温湿度、分区和进出货条件'],
    ['远芷健康科技', '质量检测用房租赁', '明确机电改造、验收和维护责任'],
    ['禾序医药服务', '医药办公用房租赁', '确认租赁交付文件和首期账单抬头'],
  ],
  wl: [
    ['雾汀旅行工作室', '园区周末游线策划', '确认目标客群、活动时段和接待规模'],
    ['渡灯文化体验', '工业遗产研学活动', '比较讲解路线、课程安排及应急预案'],
    ['巷语文创运营', '节庆市集活动执行', '明确场地交接、商户管理和活动验收条款'],
    ['寻潮旅学社', '研学团接待服务', '核对首批场次结算清单和付款时间'],
  ],
};

export function missingDepartmentStageExamples(state: WorkbenchState): Deal[] {
  if (!state.deals.some(deal => !deal.archive && deal.dataOrigin === 'research' && deal.source === DATASET_ID)) return [];

  const existingIds = new Set(state.deals.map(deal => deal.id));
  return DEPARTMENTS.flatMap(({ username, salesId, industry }) => stages.flatMap((phase, index) => {
    const id = `department-example-${username}-${phase.id}`;
    if (existingIds.has(id)) return [];
    const [company, projectName, need] = scenarios[username][index];
    const deal: Deal = {
      id, name: exampleLabel + company, projectName: exampleLabel + projectName,
      industry, ownerId: salesId, owner: username.toUpperCase(),
      stage: phase.stage, outcome: 'open', dataOrigin: 'sample', source: '合成演示项目',
      summary: `演示场景：${need}。${phase.progress}`, needs: [need], nextAction: phase.nextAction,
      amount: 0, health: 0, priority: 'medium', contact: '', position: '', lastContact: '',
      risks: [], notes: [], version: 1, avatar: company[0],
    };
    return [deal];
  }));
}
