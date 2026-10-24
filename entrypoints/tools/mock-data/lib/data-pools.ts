/**
 * 模拟数据工具的数据池与底层随机/校验工具。
 *
 * 数据池移植自 FeHelper apps/mock-data/fake-data-lib.js，并做了以下修正与扩充：
 * - 姓/名分池：原实现把「秀英」「桂英」等双字名混入单字池再随机拼接，
 *   可能产出四字名；这里拆成单字名 / 双字名两个池。
 * - 省市联动：原实现省份与城市独立随机（会出现「北京市广州市」）；
 *   这里按省份→候选城市映射取值。
 * - 公司名改为「城市 + 字号 + 行业 + 后缀」合成，避免「腾讯科技有限公司」
 *   这类真实企业名直接出现在测试数据里。
 * - 新增招投标域数据池（项目主体、招标方式、评标办法等）。
 * - 新增身份证校验位（GB 11643）、统一社会信用代码校验位（GB 32100）、
 *   人民币大写金额换算，均为纯函数可单测。
 */

// ─── 基础随机 ───────────────────────────────────────────────

export function randomInt(min: number, max: number): number {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

export function randomFloat(min: number, max: number, precision = 2): number {
  const p = Number.isFinite(precision) ? Math.trunc(precision) : 2;
  const clamped = Math.min(Math.max(p, 0), 6);
  const num = Math.random() * (max - min) + min;
  return Number(num.toFixed(clamped));
}

export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function randomString(
  length: number,
  charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return out;
}

export function randomDigits(length: number): string {
  return randomString(length, '0123456789');
}

// ─── 人员数据池 ─────────────────────────────────────────────

export const SURNAMES = [
  '王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴',
  '徐', '孙', '胡', '朱', '高', '林', '何', '郭', '马', '罗',
  '梁', '宋', '郑', '谢', '韩', '唐', '冯', '于', '董', '萧',
  '程', '曹', '袁', '邓', '许', '傅', '沈', '曾', '彭', '吕',
  '苏', '卢', '蒋', '蔡', '贾', '丁', '魏', '薛', '叶', '阎',
  '余', '潘', '杜', '戴', '夏', '钟', '汪', '田', '任', '姜',
  '范', '方', '石', '姚', '谭', '廖', '邹', '熊', '金', '陆',
  '孔', '白', '崔', '康', '毛', '邱', '秦', '江', '史', '顾',
  '侯', '邵', '孟', '龙', '万', '段', '雷', '钱', '汤', '尹',
] as const;

export const GIVEN_NAMES_SINGLE = [
  '伟', '芳', '娜', '敏', '静', '丽', '强', '磊', '军', '洋',
  '勇', '艳', '杰', '娟', '涛', '明', '超', '霞', '平', '刚',
  '永', '健', '鑫', '帅', '莉', '凯', '浩', '宇', '琳', '雅',
  '欣', '晨', '阳', '雪', '晴', '萌', '悦', '博', '瑞', '琪',
  '峰', '飞', '鹏', '华', '龙', '文', '彬', '斌', '海', '建',
  '国', '志', '忠', '义', '兴', '良', '成', '康', '星', '光',
  '东', '南', '西', '北', '春', '夏', '秋', '冬', '山', '水',
  '云', '风', '雷', '雨', '天', '地', '安', '宁', '祥', '吉',
] as const;

export const GIVEN_NAMES_DOUBLE = [
  '秀英', '秀兰', '桂英', '建国', '建华', '志强', '志远', '子轩',
  '雨泽', '浩然', '欣怡', '梓涵', '诗涵', '梦瑶', '若曦', '思远',
  '文博', '雅静', '嘉懿', '煜城', '鹤轩', '明轩', '立诚', '越彬',
  '天佑', '致远', '俊驰', '雨婷', '紫萱', '佳琪', '美琳', '诗琪',
  '晓红', '晓明', '晓东', '建华', '国强', '国华', '海燕', '海涛',
  '文博', '文静', '志强', '志明', '丽萍', '丽娟', '建华', '建军',
  '思远', '思琪', '梦洁', '梦婷', '雪梅', '雪莲', '玉兰', '玉梅',
  '金龙', '银龙', '春梅', '秋菊', '夏荷', '冬梅', '晓燕', '晓丽',
] as const;

/** 中文姓名：约 65% 双字名 */
export function generateName(): string {
  const surname = pick(SURNAMES);
  const given =
    Math.random() < 0.65 ? pick(GIVEN_NAMES_DOUBLE) : pick(GIVEN_NAMES_SINGLE);
  return surname + given;
}

export const EMAIL_DOMAINS = [
  'qq.com', '163.com', '126.com', 'sina.com', 'foxmail.com',
  'gmail.com', 'outlook.com', 'hotmail.com', 'aliyun.com', 'yeah.net',
  'sohu.com', 'tom.com', '21cn.com', '139.com', '189.cn',
  '88.com', 'vip.qq.com', 'sina.cn', '163.net', 'yahoo.com',
] as const;

export const PHONE_PREFIXES = [
  '130', '131', '132', '133', '135', '136', '137', '138', '139',
  '150', '151', '152', '155', '156', '157', '158', '159',
  '166', '167', '172', '175', '176', '177', '178',
  '180', '181', '182', '183', '185', '186', '187', '188', '189',
  '191', '193', '195', '196', '198', '199',
] as const;

// ─── 地址数据池（省市联动） ──────────────────────────────────

/** 省份 → 候选城市（未收录的省份回退到省会池） */
export const PROVINCE_CITIES: Record<string, readonly string[]> = {
  北京市: ['北京市'],
  上海市: ['上海市'],
  天津市: ['天津市'],
  重庆市: ['重庆市'],
  河北省: ['石家庄市', '唐山市', '保定市', '廊坊市', '沧州市'],
  山西省: ['太原市', '大同市', '临汾市', '运城市'],
  江苏省: ['南京市', '苏州市', '无锡市', '常州市', '南通市', '徐州市'],
  浙江省: ['杭州市', '宁波市', '温州市', '嘉兴市', '绍兴市'],
  安徽省: ['合肥市', '芜湖市', '蚌埠市', '安庆市'],
  福建省: ['福州市', '厦门市', '泉州市', '漳州市'],
  江西省: ['南昌市', '赣州市', '九江市', '上饶市'],
  山东省: ['济南市', '青岛市', '烟台市', '潍坊市', '临沂市'],
  河南省: ['郑州市', '洛阳市', '开封市', '新乡市'],
  湖北省: ['武汉市', '宜昌市', '襄阳市', '荆州市'],
  湖南省: ['长沙市', '株洲市', '湘潭市', '衡阳市'],
  广东省: ['广州市', '深圳市', '珠海市', '佛山市', '东莞市'],
  四川省: ['成都市', '绵阳市', '德阳市', '宜宾市'],
  陕西省: ['西安市', '咸阳市', '宝鸡市', '渭南市'],
  辽宁省: ['沈阳市', '大连市', '鞍山市', '锦州市'],
  吉林省: ['长春市', '吉林市', '四平市'],
  黑龙江省: ['哈尔滨市', '大庆市', '齐齐哈尔市'],
  海南省: ['海口市', '三亚市'],
  贵州省: ['贵阳市', '遵义市', '六盘水市'],
  云南省: ['昆明市', '曲靖市', '大理市'],
  甘肃省: ['兰州市', '天水市', '酒泉市'],
  青海省: ['西宁市', '海东市'],
  内蒙古自治区: ['呼和浩特市', '包头市', '鄂尔多斯市'],
  广西壮族自治区: ['南宁市', '柳州市', '桂林市'],
  宁夏回族自治区: ['银川市', '石嘴山市'],
  新疆维吾尔自治区: ['乌鲁木齐市', '克拉玛依市'],
  西藏自治区: ['拉萨市', '日喀则市'],
};

export const PROVINCES = Object.keys(PROVINCE_CITIES);

const DISTRICT_NAMES = [
  '城中区', '高新区', '经开区', '滨江区', '新城区', '云溪区',
  '望江区', '金川区', '龙马潭区', '章贡区', '和平区', '朝阳区',
  '海淀区', '丰台区', '江宁区', '浦口区', '余杭区', '萧山区',
  '西湖区', '拱墅区', '上城区', '下城区', '武侯区', '锦江区',
  '青羊区', '金牛区', '天河区', '越秀区', '荔湾区', '番禺区',
] as const;

const STREET_NAMES = [
  '人民路', '建设路', '解放大道', '中山路', '和平街', '长江路',
  '黄河大街', '科技大道', '创新路', '迎宾路', '文化巷', '胜利街',
  '北京路', '上海路', '广州路', '深圳路', '杭州路', '南京路',
  '成都路', '武汉路', '西安路', '重庆路', '天津路', '苏州路',
  '工业大道', '学院路', '学府路', '商业街', '金融街', '科技园路',
] as const;

export function generateAddress(): string {
  const province = pick(PROVINCES);
  const city = pick(PROVINCE_CITIES[province]);
  // 直辖市的「市辖区」不再重复拼接城市名
  const isMunicipality = city === province;
  const district = pick(DISTRICT_NAMES);
  const street = pick(STREET_NAMES);
  const no = randomInt(1, 1999);
  return isMunicipality
    ? `${province}${district}${street}${no}号`
    : `${province}${city}${district}${street}${no}号`;
}

// ─── 企业数据池 ─────────────────────────────────────────────

const COMPANY_SIZES = [
  '云帆', '恒信', '博瑞', '中晟', '华创', '天成', '金鼎', '蓝海',
  '星辰', '睿达', '嘉禾', '锦程', '泰和', '宏图', '方圆', '鼎盛',
  '安平', '伟业', '润泽', '启程', '山水', '长风', '正阳', '联合',
  '中信', '国盛', '民丰', '远东', '新华', '东方', '南方', '北方',
  '万通', '百事', '千禧', '亿达', '兆丰', '汇源', '通达', '利达',
  '瑞丰', '福来', '祥泰', '德昌', '顺达', '康盛', '美嘉', '优创',
] as const;

const COMPANY_INDUSTRIES = [
  '科技', '建设', '工程', '建设工程', '贸易', '实业', '网络科技',
  '环保', '机械', '电子', '信息', '智能科技', '市政工程', '园林绿化',
  '机电设备安装', '工程咨询', '招标代理', '监理',
  '房地产', '物业管理', '物流', '运输', '农业', '食品',
  '医药', '化工', '新材料', '新能源', '生物医药', '文化传媒',
  '教育', '旅游', '酒店', '餐饮', '金融服务', '保险',
] as const;

const COMPANY_SUFFIXES = [
  '有限公司', '有限公司', '有限公司', '股份有限公司', '集团有限公司',
] as const;

/** 城市名去「市」后拼接，如「杭州云帆科技有限公司」 */
export function generateCompany(): string {
  const province = pick(PROVINCES);
  const city = pick(PROVINCE_CITIES[province]).replace(/市$/, '');
  return `${city}${pick(COMPANY_SIZES)}${pick(COMPANY_INDUSTRIES)}${pick(COMPANY_SUFFIXES)}`;
}

export const DEPARTMENTS = [
  '技术部', '产品部', '运营部', '市场部', '销售部', '人事部',
  '财务部', '行政部', '法务部', '客服部', '设计部', '测试部',
  '运维部', '数据部', '商务部', '品牌部', '投标部', '采购部',
  '研发中心', '质量管理部', '安全管理部', '审计部', '投资部',
  '战略发展部', '人力资源部', '综合管理部', '市场营销部', '售后服务部',
] as const;

export const POSITIONS = [
  '前端工程师', '后端工程师', '全栈工程师', '移动端工程师', 'DevOps工程师',
  '产品经理', '项目经理', '技术经理', '运营专员', '市场专员',
  'UI设计师', '测试工程师', '数据分析师', '算法工程师', '架构师',
  '总监', '主管', '专员', '商务专员', '投标专员', '造价工程师',
  '总经理', '副总经理', '部门经理', '副总裁', '总裁',
  '实习生', '助理', '顾问', '顾问工程师', '高级工程师',
] as const;

export const CURRENCIES = [
  'CNY', 'CNY', 'CNY', 'USD', 'EUR', 'JPY', 'GBP', 'HKD',
] as const;

const BANK_CARD_PREFIXES = [
  '6225', '6222', '6228', '6229', '6227', '6223', '6226', '6217',
  '6214', '6212', '6210', '6205', '6200', '6250', '6251', '6258',
  '6259', '6260', '6264', '6265', '6270', '6271', '6272', '6273',
] as const;

/** 主要银行名称 */
export const BANK_NAMES = [
  '中国工商银行', '中国建设银行', '中国农业银行', '中国银行',
  '交通银行', '招商银行', '浦发银行', '中信银行',
  '光大银行', '华夏银行', '民生银行', '兴业银行',
  '平安银行', '广发银行', '北京银行', '上海银行',
] as const;

export function generateBankCard(): string {
  return pick(BANK_CARD_PREFIXES) + randomDigits(12);
}

// ─── 招投标数据池 ────────────────────────────────────────

const PROJECT_SUBJECTS = [
  '城市快速路改造工程', '污水处理厂二期扩建工程', '智慧园区管理系统建设',
  '办公楼装修改造工程', '教学设备采购项目', '医疗设备采购项目',
  '市政道路提升改造工程', '景观绿化提升工程', '消防系统工程',
  '电梯采购及安装项目', '安防监控系统建设', '数据中心建设工程',
  '新能源汽车充电桩建设项目', '高标准农田建设项目', '河道综合治理工程',
  '保障性住房建设工程', '教学楼改扩建工程', '门诊楼建设工程',
  '图书馆图书采购项目', '交通信号灯改造工程', '老旧小区改造工程',
  '地下综合管廊建设工程', '光伏发电站建设项目', '供水管网改造工程',
  '智慧城市信息化建设项目', '电子政务系统升级工程', '公共卫生服务中心建设',
  '体育场馆建设工程', '文化艺术中心装修工程', '养老院设备采购项目',
  '污水处理厂提标改造工程', '垃圾分类处理系统建设', '停车场智能管理系统',
  '城市照明节能改造工程', '燃气管网改造工程', '热力管网改造工程',
  '水利枢纽工程', '水库除险加固工程', '灌区续建配套工程',
  '高速公路建设项目', '铁路枢纽改造工程', '机场扩建工程',
  '港口码头建设项目', '物流园区建设工程', '产业园区基础设施配套',
] as const;

/** 招标/采购项目名称，如「杭州市智慧园区管理系统建设项目」 */
export function generateProjectName(): string {
  const province = pick(PROVINCES);
  const city = pick(PROVINCE_CITIES[province]);
  return `${city}${pick(PROJECT_SUBJECTS)}`;
}

export const SECTION_NAMES = [
  '施工一标段', '施工二标段', '监理标段', '设备采购标段',
  '安装工程标段', '设计标段', '勘察标段', '系统集成标段',
  '第一标段', '第二标段', '第三标段', '第四标段',
  'A标段', 'B标段', 'C标段', 'D标段',
  '土建标段', '安装标段', '装修标段', '弱电标段',
] as const;

export const TENDER_METHODS = [
  '公开招标', '公开招标', '公开招标', // 公开招标更常见
  '邀请招标', '竞争性谈判', '竞争性磋商', '单一来源采购', '询价',
] as const;

export const EVAL_METHODS = [
  '综合评估法', '综合评估法', '经评审的最低投标价法',
  '合理低价法', '最低评标价法', '综合评分法', '性价比法',
  '最低评标价法', '经评审的合理低价法', '技术评分最低标价法',
] as const;

// ─── 技术数据池 ─────────────────────────────────────────────

export const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
] as const;

export const MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  'text/html', 'text/css', 'text/plain', 'text/csv',
  'application/json', 'application/xml', 'application/pdf', 'application/zip',
  'video/mp4', 'audio/mpeg',
  'image/bmp', 'image/tiff', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/x-rar-compressed', 'application/x-7z-compressed',
  'audio/wav', 'audio/ogg', 'video/webm', 'video/avi',
] as const;

export const FILE_EXTENSIONS = [
  'jpg', 'png', 'pdf', 'doc', 'docx', 'xls', 'xlsx',
  'ppt', 'pptx', 'txt', 'csv', 'json', 'zip', 'mp4',
  'gif', 'bmp', 'tiff', 'rar', '7z', 'mp3', 'wav',
  'avi', 'mov', 'html', 'css', 'js', 'ts', 'vue',
] as const;

export const DOMAIN_SUFFIXES = [
  'com', 'cn', 'net', 'org', 'com.cn', 'net.cn', 'gov.cn',
] as const;

const URL_PATHS = [
  '/', '/home', '/about', '/products', '/services',
  '/api/list', '/api/detail', '/news', '/contact',
  '/login', '/register', '/user/profile', '/dashboard',
  '/api/v1/users', '/api/v1/products', '/api/v1/orders',
  '/blog', '/blog/post/1', '/faq', '/terms', '/privacy',
  '/search', '/cart', '/checkout', '/help', '/support',
] as const;

export function generateUrl(): string {
  const proto = Math.random() < 0.8 ? 'https' : 'http';
  return `${proto}://www.${randomString(randomInt(4, 10), 'abcdefghijklmnopqrstuvwxyz')}.${pick(DOMAIN_SUFFIXES)}${pick(URL_PATHS)}`;
}

// ─── 身份证（GB 11643） ──────────────────────────────────────

const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK_CODES = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

/** 计算身份证第 18 位校验码（前 17 位为数字字符串） */
export function idCardCheckCode(first17: string): string {
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(first17[i]) * ID_WEIGHTS[i];
  return ID_CHECK_CODES[sum % 11];
}

const ID_AREA_CODES = [
  '110101', '110105', '310104', '310110', '440103', '440305',
  '320102', '320505', '330103', '330106', '510104', '510107',
  '420102', '420111', '370102', '370202', '610103', '610113',
  '210102', '210202', '220102', '230102', '130102', '140102',
  '150102', '150202', '340102', '350102', '360102', '410102',
  '430102', '450102', '460102', '500102', '520102', '530102',
  '540102', '620102', '630102', '640102', '650102', '320104',
  '320105', '320106', '320111', '320113', '320114', '320115',
] as const;

/** 生成带正确校验位的 18 位身份证号 */
export function generateIdCard(): string {
  const area = pick(ID_AREA_CODES);
  const year = randomInt(1965, 2003);
  const month = String(randomInt(1, 12)).padStart(2, '0');
  const day = String(randomInt(1, 28)).padStart(2, '0');
  const seq = randomDigits(3);
  const first17 = `${area}${year}${month}${day}${seq}`;
  return first17 + idCardCheckCode(first17);
}

// ─── 统一社会信用代码（GB 32100） ────────────────────────────

/** 代码字符集（不含 I、O、S、Z、V） */
export const USCC_CHARSET = '0123456789ABCDEFGHJKLMNPQRTUWXY';
const USCC_WEIGHTS = [
  1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28,
];

/** 计算统一社会信用代码第 18 位校验字符（前 17 位须取自 USCC_CHARSET） */
export function usccCheckCode(first17: string): string {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    sum += USCC_CHARSET.indexOf(first17[i]) * USCC_WEIGHTS[i];
  }
  return USCC_CHARSET[(31 - (sum % 31)) % 31];
}

/**
 * 生成带正确校验位的 18 位统一社会信用代码：
 * 「91」（工商部门登记的企业）+ 6 位行政区划 + 9 位主体标识码 + 校验位
 */
export function generateUscc(): string {
  const area = pick(ID_AREA_CODES);
  const body = randomString(9, USCC_CHARSET);
  const first17 = `91${area}${body}`;
  return first17 + usccCheckCode(first17);
}

// ─── 人民币大写金额 ─────────────────────────────────────────

const CN_DIGITS = '零壹贰叁肆伍陆柒捌玖';
const CN_SMALL_UNITS = ['', '拾', '佰', '仟'];
const CN_BIG_UNITS = ['', '万', '亿', '万亿'];

/** 四位以内数字 → 中文（不含大单位），内部零折叠 */
function fourToCn(num: number): string {
  let out = '';
  let pendingZero = false;
  for (let pos = 3; pos >= 0; pos--) {
    const d = Math.floor(num / 10 ** pos) % 10;
    if (d === 0) {
      if (out) pendingZero = true;
    } else {
      if (pendingZero) {
        out += '零';
        pendingZero = false;
      }
      out += CN_DIGITS[d] + CN_SMALL_UNITS[pos];
    }
  }
  return out;
}

/**
 * 数字金额 → 人民币大写（精确到分，四舍五入）。
 * 例：105.3 → 壹佰零伍圆叁角；1002.01 → 壹仟零贰圆零壹分；100000 → 壹拾万圆整
 */
export function toChineseCapital(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) return '';
  if (amount === 0) return '零圆整';

  const totalCents = Math.round(amount * 100);
  let integerPart = Math.floor(totalCents / 100);
  const jiao = Math.floor((totalCents % 100) / 10);
  const fen = totalCents % 10;

  let intCn = '';
  if (integerPart > 0) {
    const groups: number[] = [];
    while (integerPart > 0) {
      groups.push(integerPart % 10000);
      integerPart = Math.floor(integerPart / 10000);
    }
    for (let g = groups.length - 1; g >= 0; g--) {
      const val = groups[g];
      if (val === 0) continue;
      // 当前组不足千位且高位已有内容时，组间补零（如 壹拾万零壹）
      if (intCn && val < 1000) intCn += '零';
      intCn += fourToCn(val) + CN_BIG_UNITS[g];
    }
  }

  let frac = '';
  if (jiao === 0 && fen === 0) {
    frac = '整';
  } else {
    if (jiao > 0) frac += `${CN_DIGITS[jiao]}角`;
    else if (intCn && fen > 0) frac += '零';
    if (fen > 0) frac += `${CN_DIGITS[fen]}分`;
  }
  return (intCn ? `${intCn}圆` : '') + frac;
}

// ─── 车牌号（中国） ──────────────────────────────────────────

/** 省份简称（用于车牌首位） */
export const PLATE_PROVINCES = [
  '京', '沪', '津', '渝', '冀', '豫', '云', '辽', '黑',
  '湘', '皖', '鲁', '新', '苏', '浙', '赣', '鄂', '桂',
  '甘', '晋', '蒙', '陕', '吉', '闽', '贵', '粤', '川',
  '藏', '琼', '宁', '青',
] as const;

const PLATE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/** 生成中国车牌号（如 京A12345） */
export function generatePlateNumber(): string {
  const province = pick(PLATE_PROVINCES);
  const letter = PLATE_LETTERS.charAt(Math.floor(Math.random() * PLATE_LETTERS.length));
  const digits = randomDigits(5);
  return `${province}${letter}${digits}`;
}

// ─── 颜色 ────────────────────────────────────────────────────

export const COLOR_NAMES = [
  '红色', '蓝色', '绿色', '黄色', '紫色', '橙色', '粉色', '棕色',
  '黑色', '白色', '灰色', '青色', '金色', '银色', '米色', '驼色',
  '藏蓝色', '酒红色', '墨绿色', '浅蓝色', '深紫色', '卡其色',
] as const;

export const HEX_COLORS = [
  '#FF0000', '#0000FF', '#00FF00', '#FFFF00', '#800080', '#FFA500',
  '#FFC0CB', '#A52A2A', '#000000', '#FFFFFF', '#808080', '#00FFFF',
  '#FFD700', '#C0C0C0', '#F5F5DC', '#D2B48C', '#000080', '#800000',
] as const;

// ─── 中文句子（Lorem ipsum 替代） ────────────────────────────

export const CN_SENTENCES = [
  '今天天气真不错，适合出去走走。',
  '这个项目进展顺利，预计月底可以完成。',
  '我们需要在下周之前提交报告。',
  '这个方案得到了领导的一致认可。',
  '技术团队正在加紧开发新功能。',
  '客户要求我们提供更多的设计方案。',
  '这次会议讨论了几个关键问题。',
  '市场部已经完成了季度推广计划。',
  '新产品的测试结果超出预期。',
  '人力资源部门正在组织培训活动。',
  '这个系统的性能优化效果显著。',
  '财务部门已完成年度预算编制。',
  '研发团队成功解决了一个技术难题。',
  '客服部门收到了大量用户反馈。',
  '公司决定扩大生产规模。',
  '这个季度的销售额同比增长了百分之二十。',
  '新政策对行业影响深远。',
  '我们正在寻找合适的合作伙伴。',
  '这个项目具有重要的战略意义。',
  '团队协作效率显著提升。',
] as const;

/** 随机生成 N 句中文段落 */
export function generateCnParagraph(sentenceCount = 5): string {
  const sentences: string[] = [];
  for (let i = 0; i < sentenceCount; i++) {
    sentences.push(pick(CN_SENTENCES));
  }
  return sentences.join('');
}

// ─── 产品名 ──────────────────────────────────────────────────

const PRODUCT_ADJECTIVES = [
  '智能', '高性能', '便携式', '多功能', '节能', '环保',
  '创新', '专业', '经典', '豪华', '时尚', '简约',
  '旗舰', '至尊', '灵动', '卓越', '精致', '优雅',
] as const;

const PRODUCT_NOUNS = [
  '手机', '电脑', '平板', '耳机', '音箱', '相机',
  '手表', '键盘', '鼠标', '显示器', '路由器', '充电器',
  '空调', '冰箱', '洗衣机', '电视', '微波炉', '净水器',
  '无人机', '机器人', 'VR眼镜', '智能门锁', '扫地机器人',
] as const;

const PRODUCT_SERIES = [
  'Pro', 'Max', 'Plus', 'Ultra', 'Lite', 'Air',
  'SE', 'X', 'S', 'Mini', 'Note', 'Prime',
  'Series 1', 'Series 2', 'Series 3', '2024款', '2025款',
] as const;

/** 生成产品名（如「智能手机 Pro」） */
export function generateProduct(): string {
  return `${pick(PRODUCT_ADJECTIVES)}${pick(PRODUCT_NOUNS)} ${pick(PRODUCT_SERIES)}`;
}

// ─── IP 地址 ─────────────────────────────────────────────────

/** 生成随机 IPv4 地址 */
export function generateIpv4(): string {
  return `${randomInt(1, 254)}.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`;
}

/** 生成随机 IPv6 地址（简化版，8 组 4 位十六进制） */
export function generateIpv6(): string {
  const groups: string[] = [];
  for (let i = 0; i < 8; i++) {
    groups.push(randomString(4, '0123456789abcdef'));
  }
  return groups.join(':');
}

// ─── 日期相关 ─────────────────────────────────────────────────

export const WEEKDAYS = [
  '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日',
] as const;

export const MONTHS = [
  '一月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '十一月', '十二月',
] as const;

// ─── 人口统计 ─────────────────────────────────────────────────

export const ETHNIC_GROUPS = [
  '汉族', '汉族', '汉族', '汉族', '汉族', // 汉族占绝大多数
  '壮族', '回族', '满族', '维吾尔族', '苗族',
  '彝族', '土家族', '藏族', '蒙古族', '侗族',
  '布依族', '瑶族', '白族', '朝鲜族', '哈尼族',
] as const;

export const EDUCATION_LEVELS = [
  '小学', '初中', '高中', '中专', '大专',
  '本科', '本科', '本科', // 本科更常见
  '硕士研究生', '博士研究生', '博士后',
] as const;

export const MARITAL_STATUSES = [
  '未婚', '已婚', '离异', '丧偶',
] as const;

export const BLOOD_TYPES = [
  'A型', 'B型', 'AB型', 'O型', 'Rh阴性A型', 'Rh阴性B型',
] as const;

// ─── 招投标域扩展 ─────────────────────────────────────────────

/** 资质等级 */
export const QUALIFICATION_LEVELS = [
  '特级', '一级', '二级', '三级',
  '甲级', '乙级', '丙级',
  'A级', 'B级', 'C级',
] as const;

/** 资质类型 */
export const QUALIFICATION_TYPES = [
  '建筑工程施工总承包', '市政公用工程施工总承包', '机电工程施工总承包',
  '公路工程施工总承包', '水利水电工程施工总承包',
  '建筑装修装饰工程专业承包', '建筑机电安装工程专业承包',
  '消防设施工程专业承包', '防水防腐保温工程专业承包',
  '工程监理综合资质', '工程监理房屋建筑工程', '工程监理市政公用工程',
  '工程设计综合资质', '建筑行业设计', '市政行业设计',
] as const;

/** 合同类型 */
export const CONTRACT_TYPES = [
  '固定总价合同', '固定单价合同', '可调价格合同', '成本加酬金合同',
  '工程总承包合同', '施工承包合同', '专业分包合同', '劳务分包合同',
  '设计合同', '监理合同', '勘察合同', '咨询合同',
] as const;

/** 资金来源 */
export const FUND_SOURCES = [
  '财政拨款', '自筹资金', '银行贷款', '企业自筹',
  '中央预算内投资', '地方财政', '社会资本', '外商投资',
  '国有资金', '集体资金', '私人资金', '混合所有制',
] as const;

/** 投标保证金金额范围 */
export function generateBidBond(): number {
  // 投标保证金通常为估算价的 2%，最高不超过 80 万元
  const base = pick([5, 10, 20, 50, 80]); // 万元
  return base * 10000;
}

/** 中标金额（万元） */
export function generateWinAmount(): number {
  return randomFloat(100, 50000, 2);
}
