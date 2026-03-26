import json
import sys
from typing import Any, Dict, List


def parse_material_id(material_id: str) -> Dict[str, Any]:
    raw = material_id.strip()
    core = raw
    if raw.startswith('[') and raw.endswith(']'):
        core = raw[1:-1]

    parts: List[str] = []
    if ']-[' in core:
        parts = core.split(']-[')
    else:
        parts = [p.strip() for p in core.split('-') if p.strip()]

    material_info = {
        'raw': material_id,
        'name': parts[0] if len(parts) > 0 else '未知物料',
        'supplier': parts[1] if len(parts) > 1 else '未知供应商',
        'location': parts[2] if len(parts) > 2 else '未知地点',
        'node': parts[3] if len(parts) > 3 else '',
        'capacity_month': parts[4] if len(parts) > 4 else '',
        'extras': parts[5:] if len(parts) > 5 else [],
    }
    return material_info


def load_input() -> Dict[str, Any]:
    raw = sys.stdin.read()
    if not raw:
        return {}
    return json.loads(raw)


def main():
    payload = load_input()
    material_ids = payload.get('materialIds', [])
    constants = payload.get('constants', {})

    try:
        from supply_risk_model import SupplyRiskModel
    except Exception as e:
        sys.stderr.write(str(e))
        sys.exit(1)

    model = SupplyRiskModel(constants)

    params = {
        '1_TTR': 0, '1_Closs': 0,
        '2_Sban': 0, '2_Tpolicy': 0, '2_Rtariff': 0.05, '2_Tdelay': 7,
        '3_tLTB': 360, '3_Ynew': 0.92, '3_Rpen': 0.45,
        '4_U': 0.85, '4_Cnew': 0, '4_Rgrowth': 0.15, '4_Ishift': 1, '4_T': 0.3,
        '5_T': 0, '5_Closs': 0,
        '6_Tdelay': 3, '6_S': 0.95,
        '7_G': 0.15, '7_DLT': 14, '7_CR3': 0.63, '7_Icut': 0,
        '8_Rraw': 0.08, '8_Rprice': 0.03, '8_GM': 0.20, '8_INV': 45, '8_Istop': 0
    }

    horizon_days = int(constants.get('horizonDays') or 180)

    results: List[Dict[str, Any]] = []
    for mid in material_ids:
        info = parse_material_id(str(mid))

        curves_raw = model.run_all(params)
        curves = []
        for name, curve in curves_raw.items():
            y = [float(v) for v in curve[:horizon_days]]
            points = [{
                't': int(i),
                'capacity': y[i],
                'demand': float(constants.get('D')),
            } for i in range(len(y))]
            curves.append({
                'name': name,
                'points': points,
            })

        perception_df = model.generate_perception_table(info, params)
        perception_table = perception_df.to_dict(orient='records')

        recommendations = model.generate_recommendations(info, params, curves_raw)
        recs = []
        for i, r in enumerate(recommendations):
            recs.append({
                'index': i + 1,
                'text': r,
            })

        by_risk_templates = {
            'L1-1 自然/物理灾害': {
                'analysis': '该风险源主要影响复工周期与产能受损比例，表现为短期产能骤降并导致库存净消耗放大。',
                'actions': [
                    '立即测算断料临界点TTI，优先保障关键产线日消耗。',
                    '启动备选供方/跨工厂调拨，必要时采用空运或拆单加急。',
                    '将应急安全库存提高到“预计复工天数 + 额外缓冲”。',
                ],
            },
            'L1-2 合规与政治': {
                'analysis': '合规风险会通过行政审批延迟与成本阈值触发“经济性断供”，影响可交付性。',
                'actions': [
                    '建立合规提前量：提升TTS目标覆盖审批延误窗口。',
                    '准备替代报关/贸易路径方案，降低审查不确定性。',
                    '当落地成本逼近上限时，提前联动业务侧做成本传导或换料。',
                ],
            },
            'L1-3 技术迭代': {
                'analysis': '技术替代将导致旧工艺产能衰减，并在LTB节点强制归零，需提前完成替代导入。',
                'actions': [
                    '立刻推进替代料导入（AVL扩充），完成验证与量产切换排期。',
                    '与供应商确认LTB与最后备货策略，形成供货保障。',
                    '对关键型号设置“技术退市预警阈值”，提前触发换料。',
                ],
            },
            'L1-4 跨界竞争': {
                'analysis': '跨界高利润需求会挤占配额，常表现为获配下降与交付失约。',
                'actions': [
                    '推动签署LTA/年度框架锁定配额，并设置违约约束。',
                    '建立高层沟通机制，争取战略客户优先级。',
                    '对关键物料建立双供策略，降低单一产能池依赖。',
                ],
            },
            'L2-5 生产与技术': {
                'analysis': '生产异常通常突发且强度高，策略以库存缓冲与快速替代为主。',
                'actions': [
                    '预设停机应急预案：快速切换备选产线/备选工厂。',
                    '建立质量与良率监控阈值，提前识别波动并干预。',
                    '对关键耗材与易损件建立安全库存，降低单点故障概率。',
                ],
            },
            'L2-6 物流交付': {
                'analysis': '物流风险主要通过到货节奏变慢与延误累积导致断料。',
                'actions': [
                    '将订货点前移并增加在途库存，对冲延误窗口。',
                    '准备多式联运/替代港口/替代航线，形成可切换B计划。',
                    '对关键节点建立日级监控，触发即时补货。',
                ],
            },
            'L3-7 市场份额': {
                'analysis': '供需缺口与客户集中度会放大配额挤压，导致你被动“剩饭”。',
                'actions': [
                    '延长Forecast视野并用真实订单支撑更高配额。',
                    '推动VMI/寄售库存提升服务等级与可见性。',
                    '对高风险物料设置“配额红线”，触发二供与价格锁定。',
                ],
            },
            'L3-8 商业/大宗': {
                'analysis': '成本穿透会削弱供货动机，进而引发停供或强制涨价。',
                'actions': [
                    '谈判价格联动条款，减少突然停供概率。',
                    '识别关键原料替代路径与二供来源，降低价格冲击。',
                    '当毛利被侵蚀时，提前锁量锁价并准备降配/换料方案。',
                ],
            },
        }

        recommendations_by_risk = []
        for row in perception_table:
            cat = row.get('风险类别')
            t = by_risk_templates.get(cat)
            if t:
                recommendations_by_risk.append({
                    'riskCategory': cat,
                    'analysis': t['analysis'],
                    'actions': t['actions'],
                })

        results.append({
            'materialId': str(mid),
            'materialInfo': info,
            'perceptionTable': perception_table,
            'curves': curves,
            'recommendations': recs,
            'recommendationsByRisk': recommendations_by_risk,
        })

    sys.stdout.write(json.dumps({ 'materials': results }, ensure_ascii=False))


if __name__ == '__main__':
    main()
