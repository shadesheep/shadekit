/**
 * 模拟数据工具的预设模板。
 *
 * 模板即一组字段行（key + type + 可选参数覆盖），点击后整组载入字段列表。
 * 相比 FeHelper 的固定勾选组合，这里的模板产出的是可继续编辑的字段行，
 * 用户可以在模板基础上改名、调参、增删字段。
 */

export interface TemplateRow {
  key: string;
  type: string;
  params?: Record<string, unknown>;
}

export interface MockTemplate {
  id: string;
  name: string;
  /** 一句话说明适用场景（下拉选项后缀展示） */
  hint: string;
  rows: TemplateRow[];
}

export const TEMPLATES: MockTemplate[] = [
  {
    id: 'user',
    name: '用户信息',
    hint: '会员/账号系统测试',
    rows: [
      { key: 'name', type: 'name' },
      { key: 'gender', type: 'gender' },
      { key: 'age', type: 'age' },
      { key: 'phone', type: 'phone' },
      { key: 'email', type: 'email' },
      { key: 'address', type: 'address' },
    ],
  },
  {
    id: 'employee',
    name: '员工信息',
    hint: '人事/组织架构测试',
    rows: [
      { key: 'name', type: 'name' },
      { key: 'phone', type: 'phone' },
      { key: 'email', type: 'email' },
      { key: 'company', type: 'company' },
      { key: 'department', type: 'department' },
      { key: 'position', type: 'position' },
      { key: 'salary', type: 'salary' },
    ],
  },
  {
    id: 'bidder',
    name: '投标人信息',
    hint: '供应商/投标单位库',
    rows: [
      { key: 'companyName', type: 'company' },
      { key: 'uscc', type: 'uscc' },
      { key: 'contactName', type: 'name' },
      { key: 'contactPhone', type: 'phone' },
      { key: 'email', type: 'email' },
      { key: 'bankCard', type: 'bankCard' },
      { key: 'address', type: 'address' },
    ],
  },
  {
    id: 'project',
    name: '招标项目',
    hint: '招标公告/项目列表',
    rows: [
      { key: 'projectCode', type: 'projectCode' },
      { key: 'projectName', type: 'projectName' },
      { key: 'tenderMethod', type: 'tenderMethod' },
      { key: 'evalMethod', type: 'evalMethod' },
      { key: 'budget', type: 'budget' },
      { key: 'budgetCn', type: 'moneyCn' },
      { key: 'openBidTime', type: 'openBidTime' },
      { key: 'region', type: 'address' },
    ],
  },
  {
    id: 'expert',
    name: '评标专家',
    hint: '专家库/抽取名单',
    rows: [
      { key: 'name', type: 'name' },
      { key: 'gender', type: 'gender' },
      { key: 'age', type: 'age', params: { min: 30, max: 65 } },
      { key: 'idCard', type: 'idCard' },
      { key: 'phone', type: 'phone' },
      { key: 'company', type: 'company' },
      { key: 'position', type: 'position' },
    ],
  },
  {
    id: 'api',
    name: 'API 测试',
    hint: '接口/日志数据',
    rows: [
      { key: 'uuid', type: 'uuid' },
      { key: 'token', type: 'token' },
      { key: 'ip', type: 'ip' },
      { key: 'userAgent', type: 'userAgent' },
      { key: 'success', type: 'boolean' },
      {
        key: 'createdAt',
        type: 'date',
        params: { format: 'timestamp' },
      },
    ],
  },
];
