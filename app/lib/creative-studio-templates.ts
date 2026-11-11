import { STUDIO_KINDS, type StudioBoard, type StudioKind, type StudioLayer, type StudioTemplate } from './creative-studio-types.ts';

type Box = readonly [x: number, y: number, width: number, height: number];
type TextStyle = Pick<StudioLayer, 'fontSize' | 'color'> & Partial<Pick<StudioLayer, 'weight' | 'align'>>;

function layer(id: string, kind: StudioLayer['kind'], name: string, [x, y, width, height]: Box, options: Partial<StudioLayer>): StudioLayer {
  return {
    id, kind, name, x, y, width, height, text: '', assetUrl: '',
    fill: 'transparent', color: '#181818', fontSize: 16, radius: 0, weight: 'normal', align: 'left',
    ...options,
  };
}

function shape(id: string, name: string, box: Box, fill: string, radius = 0) {
  return layer(id, 'shape', name, box, { fill, radius });
}

function text(id: string, value: string, box: Box, options: TextStyle) {
  return layer(id, 'text', value.split('\n')[0], box, { text: value, ...options });
}

function button(id: string, value: string, box: Box, fill: string, color: string, fontSize: number, radius: number) {
  return layer(id, 'button', value, box, { text: value, fill, color, fontSize, radius, weight: 'bold', align: 'center' });
}

function template(kind: StudioKind, id: string, title: string, description: string, size: readonly [number, number], background: string, layers: StudioLayer[]): StudioTemplate {
  const [width, height] = size;
  return { id, title, kind, description, source: 'builtin', boards: [{ id: `${id}-board`, name: title, width, height, background, layers }] };
}

const launchBlue = '#3024A9';
const launchCream = '#F4EDDB';
const shopInk = '#202D20';
const siteInk = '#1D2128';
const appInk = '#1E2B27';
const appSage = '#D9E9CF';
const bookingInk = '#193C36';
const catalogBlue = '#152C4F';

const templatesByKind: Record<StudioKind, [StudioTemplate, ...StudioTemplate[]]> = {
  poster: [
    template('poster', 'builtin-launch', '品牌发布海报', '新品发布和品牌活动预热，预留主标题、活动信息和行动按钮。', [720, 960], launchBlue, [
      text('eyebrow', '新品发布  /  BRAND LAUNCH', [8, 8, 84, 4], { fontSize: 26, color: launchCream, weight: 'bold' }),
      shape('rule', '标题分隔线', [8, 13.5, 84, 1], '#9388E6'),
      text('headline', '全新系列\n即将亮相', [8, 17, 84, 23], { fontSize: 88, color: launchCream, weight: 'bold' }),
      shape('orbit-back', '外圆', [27, 39, 51, 38], '#8676EB', 300),
      shape('orbit-main', '主圆', [34, 44, 45, 34], '#C0B2FF', 300),
      shape('orbit-cut', '内圆', [44, 52, 27, 20], launchBlue, 200),
      shape('orbit-accent', '暖色圆点', [64, 45, 13, 10], '#FFBA83', 120),
      shape('orbit-satellite', '浅色圆点', [20, 57, 10, 7.5], launchCream, 100),
      text('detail', '新品理念  /  系列预览', [8, 83, 57, 4], { fontSize: 28, color: launchCream }),
      button('cta', '查看发布详情', [66, 82, 26, 7.2], launchCream, launchBlue, 23, 30),
    ]),
    template('poster', 'builtin-new-in', '门店上新海报', '适合餐饮、零售新品和门店活动，图形与文字都可替换。', [720, 960], '#F7EACF', [
      text('eyebrow', 'NEW IN STORE', [8, 8, 84, 5], { fontSize: 29, color: shopInk, weight: 'bold', align: 'center' }),
      text('headline', '本季上新', [8, 14, 84, 13], { fontSize: 104, color: shopInk, weight: 'bold', align: 'center' }),
      text('subtitle', '发现今天的新品', [10, 29, 80, 5], { fontSize: 30, color: shopInk, align: 'center' }),
      shape('facade', '门店外墙', [23, 44, 54, 31], '#E6BBA0', 18),
      shape('window', '展示窗', [29, 54, 24, 14], '#9BC0A5', 10),
      shape('window-sill', '展示窗底边', [29, 68, 24, 1], shopInk),
      shape('door', '门', [57, 55, 14, 20], '#48604C', 11),
      shape('awning', '条纹遮阳棚', [19, 42, 62, 11], shopInk, 16),
      shape('awning-one', '遮阳棚浅色条纹', [28, 42, 9, 11], '#CDDCA8'),
      shape('awning-two', '遮阳棚浅色条纹', [46, 42, 9, 11], '#CDDCA8'),
      shape('awning-three', '遮阳棚浅色条纹', [64, 42, 9, 11], '#CDDCA8'),
      shape('ground', '门店地面', [16, 75, 68, 1], shopInk),
      button('cta', '到店查看新品', [29, 83, 42, 8], shopInk, '#F7EACF', 30, 40),
    ]),
  ],
  web: [
    template('web', 'builtin-landing', '产品落地页', '带产品主张、行动入口、产品界面示意和卖点区。', [1440, 900], '#F5F3EC', [
      text('brand', '产品名称', [6, 6, 25, 4], { fontSize: 32, color: siteInk, weight: 'bold' }),
      text('navigation', '功能亮点      使用场景      联系我们', [49, 6, 44, 4], { fontSize: 23, color: siteInk, align: 'right' }),
      shape('divider', '导航分隔线', [6, 12, 88, 1], '#DDD9CF'),
      text('headline', '把工作安排得\n更清楚', [6, 23, 44, 23], { fontSize: 76, color: siteInk, weight: 'bold' }),
      text('description', '在这里说明产品帮用户完成什么。', [6, 50, 45, 5], { fontSize: 26, color: '#4C5056' }),
      button('cta', '了解产品', [6, 59, 15, 7], siteInk, '#FFFFFF', 24, 22),
      shape('product-frame', '产品预览底板', [53, 19, 41, 50], '#D9E7DF', 40),
      shape('product-panel', '应用界面', [58, 26, 31, 36], '#FFFFFF', 28),
      shape('product-sidebar', '应用菜单底板', [60, 29, 7, 29], '#ECEFE9', 12),
      text('product-title', '工作概览', [69, 31, 18, 4], { fontSize: 23, color: siteInk, weight: 'bold' }),
      shape('preview-row-one', '界面内容行', [69, 39, 17, 5], '#B8D0BF', 11),
      shape('preview-row-two', '界面内容行', [69, 46, 17, 5], '#DFE9DE', 11),
      shape('preview-row-three', '界面内容行', [69, 53, 12, 4], '#EFEDE6', 11),
      shape('feature', '卖点区底板', [6, 76, 88, 16], '#EAE6DA', 24),
      text('features', '产品亮点                   适用团队                   实施方式', [9, 82, 82, 5], { fontSize: 30, color: siteInk, weight: 'bold', align: 'center' }),
    ]),
    template('web', 'builtin-event', '活动报名页', '以活动主题和报名为主，底部安排议程、对象与地点。', [1440, 900], '#F6F2FF', [
      text('brand', '品牌活动', [6, 6, 35, 5], { fontSize: 32, color: '#31214F', weight: 'bold' }),
      text('navigation', '活动安排      报名信息', [62, 7, 31, 4], { fontSize: 23, color: '#55446E', align: 'right' }),
      shape('hero', '活动主视觉底板', [6, 16, 88, 57], '#352060', 38),
      shape('orbital-outer', '外层圆', [65, 23, 23, 37], '#7255B0', 280),
      shape('orbital-inner', '内层圆', [69, 29, 15, 24], '#BFB1F9', 240),
      shape('orbital-dot', '橙色圆点', [79, 31, 6, 10], '#FFB394', 160),
      text('headline', '品牌交流会', [10, 29, 52, 14], { fontSize: 86, color: '#FFFFFF', weight: 'bold' }),
      text('description', '活动介绍、嘉宾与报名安排', [10, 45, 49, 6], { fontSize: 31, color: '#E4DAFF' }),
      button('cta', '查看报名方式', [10, 56, 18, 8], '#D9C7FF', '#352060', 26, 24),
      shape('agenda-card', '活动议程底板', [6, 78, 28, 15], '#E9DFFF', 24),
      shape('audience-card', '适合人群底板', [36, 78, 28, 15], '#EDE5FA', 24),
      shape('venue-card', '活动地点底板', [66, 78, 28, 15], '#E9DFFF', 24),
      text('agenda', '活动议程', [9, 83, 22, 5], { fontSize: 29, color: '#31214F', weight: 'bold' }),
      text('audience', '适合人群', [39, 83, 22, 5], { fontSize: 29, color: '#31214F', weight: 'bold' }),
      text('venue', '活动地点', [69, 83, 22, 5], { fontSize: 29, color: '#31214F', weight: 'bold' }),
    ]),
  ],
  app: [
    template('app', 'builtin-app-home', 'App 工作首页', '包含工作摘要、任务列表和底部导航，可改作日程或跟进首页。', [430, 860], '#F4F3E9', [
      text('greeting', '我的工作台', [7, 7, 86, 7], { fontSize: 42, color: appInk, weight: 'bold' }),
      text('subtitle', '安排今日重点和下一步行动', [7, 15, 86, 5], { fontSize: 17, color: '#485952' }),
      shape('focus', '今日重点卡片', [7, 22, 86, 26], appInk, 24),
      text('focus-label', '今日重点', [12, 26, 74, 4], { fontSize: 18, color: appSage, weight: 'bold' }),
      text('focus-text', '安排新的任务', [12, 32, 73, 6], { fontSize: 30, color: '#FFFFFF', weight: 'bold' }),
      button('focus-action', '查看日程', [12, 40, 29, 5], appSage, appInk, 17, 18),
      text('tasks-title', '待处理', [7, 53, 86, 5], { fontSize: 24, color: appInk, weight: 'bold' }),
      shape('task-one', '任务卡片', [7, 60, 86, 10], '#FFFFFF', 19),
      shape('task-two', '任务卡片', [7, 72, 86, 10], '#FFFFFF', 19),
      shape('task-one-icon', '任务状态', [12, 63, 8, 4], '#D8E8CD', 24),
      shape('task-two-icon', '任务状态', [12, 75, 8, 4], '#ECDDC0', 24),
      text('task-one-label', '整理本周沟通重点', [24, 63, 62, 4], { fontSize: 19, color: appInk }),
      text('task-two-label', '补充活动准备清单', [24, 75, 62, 4], { fontSize: 19, color: appInk }),
      shape('navbar', '底部导航', [7, 89, 86, 6], '#E2E9D9', 25),
      text('nav', '首页        日程        我的', [9, 90, 82, 4], { fontSize: 18, color: appInk, weight: 'bold', align: 'center' }),
    ]),
    template('app', 'builtin-app-event', 'App 活动详情', '一屏组织活动主视觉、活动介绍和报名操作。', [430, 860], '#FFF7E9', [
      text('back', '返回活动', [7, 6, 40, 4], { fontSize: 17, color: '#4A3026' }),
      shape('hero', '暖色主视觉', [7, 13, 86, 33], '#F1BB96', 24),
      shape('sun', '红色圆', [27, 18, 46, 23], '#B9432E', 150),
      shape('floor', '舞台底座', [23, 35, 54, 6], '#684336', 13),
      shape('reflection', '舞台高光', [35, 33, 30, 5], '#FFE6B9', 16),
      text('tag', '线下活动', [7, 51, 86, 4], { fontSize: 18, color: '#833423', weight: 'bold' }),
      text('headline', '品牌开放日', [7, 57, 86, 8], { fontSize: 39, color: '#352019', weight: 'bold' }),
      text('details', '添加活动时间、地点与现场安排。', [7, 68, 86, 6], { fontSize: 19, color: '#553A30' }),
      shape('rule', '报名区分隔线', [7, 79, 86, 1], '#E6CFB8'),
      button('register', '查看报名详情', [7, 84, 86, 8], '#A33726', '#FFFFFF', 23, 22),
    ]),
  ],
  mini: [
    template('mini', 'builtin-mini-booking', '小程序预约页', '可改作看场、到店或咨询预约，包含选项和确认入口。', [390, 780], '#EDF6EF', [
      text('nav', '服务预约', [8, 6, 84, 5], { fontSize: 22, color: bookingInk, weight: 'bold', align: 'center' }),
      shape('hero', '预约说明卡片', [7, 14, 86, 22], '#C6E4D5', 24),
      shape('clock', '时钟外圆', [70, 20, 15, 7.5], '#387367', 60),
      shape('clock-face', '时钟表盘', [72, 21, 11, 5.5], '#E9F5EB', 60),
      shape('clock-hand-v', '时针', [77, 22, 1, 2.5], '#387367'),
      shape('clock-hand-h', '分针', [77, 24, 4, 1], '#387367'),
      text('headline', '预约到访', [12, 20, 56, 6], { fontSize: 33, color: bookingInk, weight: 'bold' }),
      text('subtitle', '填写时间与联系方式', [12, 28, 66, 4], { fontSize: 17, color: bookingInk }),
      text('section', '预约信息', [7, 42, 86, 5], { fontSize: 24, color: bookingInk, weight: 'bold' }),
      shape('booking-form', '预约字段底板', [7, 49, 86, 27], '#FFFFFF', 20),
      text('date', '选择预约日期', [12, 53, 75, 5], { fontSize: 19, color: bookingInk }),
      text('period', '选择到访时段', [12, 61, 75, 5], { fontSize: 19, color: bookingInk }),
      text('contact', '填写联系方式', [12, 69, 75, 5], { fontSize: 19, color: bookingInk }),
      button('confirm', '确认预约', [7, 83, 86, 8], '#225B50', '#FFFFFF', 22, 22),
    ]),
    template('mini', 'builtin-mini-catalog', '小程序品牌馆', '用首屏主视觉和双列卡片展示产品、服务或门店特色。', [390, 780], '#F1F5FA', [
      text('nav', '品牌馆', [7, 6, 86, 5], { fontSize: 22, color: catalogBlue, weight: 'bold', align: 'center' }),
      shape('hero', '产品系列主视觉', [7, 15, 86, 29], catalogBlue, 24),
      shape('blue-disc', '主视觉圆形', [64, 21, 24, 12], '#3D6C97', 80),
      shape('blue-highlight', '主视觉高光', [72, 23, 13, 6.5], '#BDE3E8', 60),
      text('headline', '发现本季系列', [12, 22, 60, 6], { fontSize: 27, color: '#FFFFFF', weight: 'bold' }),
      text('subhead', '精选产品与服务', [12, 31, 65, 5], { fontSize: 17, color: '#D5E6F5' }),
      text('featured', '精选推荐', [7, 50, 86, 5], { fontSize: 24, color: catalogBlue, weight: 'bold' }),
      shape('product-one', '左侧产品卡', [7, 58, 41, 24], '#FFFFFF', 17),
      shape('product-two', '右侧产品卡', [52, 58, 41, 24], '#FFFFFF', 17),
      shape('product-one-art', '左侧产品图形', [10, 60, 35, 14], '#CFDFEF', 12),
      shape('product-two-art', '右侧产品图形', [55, 60, 35, 14], '#C7E5DF', 12),
      shape('product-one-shape', '产品轮廓', [22, 62, 11, 10], '#39658C', 14),
      shape('product-two-shape', '产品轮廓', [64, 63, 17, 8], '#386F64', 32),
      text('product-one-label', '产品系列', [11, 75.5, 32, 4], { fontSize: 17, color: catalogBlue, weight: 'bold' }),
      text('product-two-label', '特色服务', [56, 75.5, 32, 4], { fontSize: 17, color: catalogBlue, weight: 'bold' }),
      shape('navbar', '底部导航', [7, 88, 86, 6], '#DCE6F1', 24),
      text('nav-links', '首页        分类        我的', [9, 89, 82, 4], { fontSize: 17, color: catalogBlue, weight: 'bold', align: 'center' }),
    ]),
  ],
};

export const BUILTIN_STUDIO_TEMPLATES: readonly StudioTemplate[] = STUDIO_KINDS.flatMap(kind => templatesByKind[kind]);

export function createStarterBoards(kind: StudioKind): StudioBoard[] {
  return structuredClone(templatesByKind[kind][0].boards);
}
