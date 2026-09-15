import React, { useState } from 'react';
import {
  Terminal,
  Activity,
  Layers,
  MapPin,
  CloudRain,
  Compass,
  Eye,
  ChevronRight,
  Loader2,
  CircleSlash2,
} from 'lucide-react';
import { ToolCallInfo } from '../services/api';
import { ErrorBoundary } from './ErrorBoundary';

const SiteEnvironmentCard = React.lazy(() =>
  import('./SiteEnvironmentCard').then((module) => ({ default: module.SiteEnvironmentCard }))
);

interface InlineToolCallProps {
  toolCall: ToolCallInfo;
}

export const toFiniteGnssNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const formatGnssValue = (value: unknown): string => {
  const parsed = toFiniteGnssNumber(value);
  return parsed === null ? '—' : parsed.toFixed(3);
};

export const InlineToolCall: React.FC<InlineToolCallProps> = ({ toolCall }) => {
  const [expanded, setExpanded] = useState(false);

  // 稳健解析工具详情数据
  const parseData = (val: any): any => {
    if (!val) return null;
    let res = val;
    if (typeof val === 'string') {
      try {
        res = JSON.parse(val);
      } catch {
        return { raw: val };
      }
    }
    if (res && typeof res === 'object') {
      if (res.detail) return parseData(res.detail);
      if (res.result && typeof res.result === 'object') return res.result;
    }
    return res;
  };

  const parsedDetail = parseData(toolCall.detail);
  const data: any =
    parsedDetail && typeof parsedDetail === 'object' ? { ...parsedDetail } : parsedDetail;
  // chart_points 随当前工具 artifact 转发（全量数据，不进入 LLM 上下文），
  // 合并到展示数据中供图表组件使用。
  if (data && toolCall.chartPoints?.length && !data.chart_points) {
    data.chart_points = toolCall.chartPoints;
  }

  // 图标
  const renderIcon = () => {
    if (toolCall.status === 'loading') {
      return <Loader2 className="w-3.5 h-3.5 text-neutral-400 animate-spin shrink-0" />;
    }
    if (toolCall.status === 'cancelled') {
      return <CircleSlash2 className="w-3.5 h-3.5 text-neutral-400 shrink-0" />;
    }
    if (toolCall.name?.includes('group')) {
      return <Layers className="w-3.5 h-3.5 text-neutral-400 shrink-0" />;
    }
    if (toolCall.name?.includes('site_environment')) {
      return <Compass className="w-3.5 h-3.5 text-amber-600 shrink-0" />;
    }
    if (toolCall.name?.includes('station') && !toolCall.name?.includes('group')) {
      return <MapPin className="w-3.5 h-3.5 text-neutral-400 shrink-0" />;
    }
    if (toolCall.name?.includes('gnss') || toolCall.name?.includes('data')) {
      return <Activity className="w-3.5 h-3.5 text-neutral-400 shrink-0" />;
    }
    if (toolCall.name?.includes('weather')) {
      return <CloudRain className="w-3.5 h-3.5 text-neutral-400 shrink-0" />;
    }
    if (toolCall.name?.includes('chart') || toolCall.name?.includes('vision')) {
      return <Eye className="w-3.5 h-3.5 text-neutral-400 shrink-0" />;
    }
    return <Terminal className="w-3.5 h-3.5 text-neutral-400 shrink-0" />;
  };

  // 生成简约的中文动作文案（类似“运行了命令”）
  const getActionText = () => {
    const suffix = toolCall.status === 'cancelled' ? '（已停止）' : '';
    if (toolCall.name === 'list_station_groups') {
      return `查询监测点分组${suffix}`;
    }
    if (toolCall.name === 'list_stations') {
      return `查询监测点列表${suffix}`;
    }
    if (toolCall.name === 'get_daily_gnss_data') {
      return `获取北斗GNSS日监测数据${suffix}`;
    }
    if (toolCall.name === 'query_weather') {
      return `查询天气数据${suffix}`;
    }
    if (toolCall.name === 'analyze_gnss_chart') {
      return `视觉复核${suffix}`;
    }
    if (toolCall.name === 'inspect_site_environment') {
      return `调查站点地形与地质环境${suffix}`;
    }
    return `${toolCall.display_name || '执行技术步骤'}${suffix}`;
  };

  // 由 chart_points 生成单方向迷你 SVG 折线（归一化到 0~100 视口）
  const buildPolyline = (points: any[], key: string): { lines: string[]; min: number; max: number } | null => {
    const values = points
      .map((p) => toFiniteGnssNumber(p[key]))
      .filter((value): value is number => value !== null);
    if (values.length < 2) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const lines: string[] = [];
    let segment: string[] = [];
    points.forEach((p, i) => {
        const x = (i / (points.length - 1)) * 100;
        const v = toFiniteGnssNumber(p[key]);
        if (v === null) {
          if (segment.length >= 2) lines.push(segment.join(' '));
          segment = [];
          return;
        }
        const y = 100 - ((v - min) / span) * 100;
        segment.push(`${x.toFixed(2)},${Math.max(2, Math.min(98, y)).toFixed(2)}`);
      });
    if (segment.length >= 2) lines.push(segment.join(' '));
    return lines.length > 0 ? { lines, min, max } : null;
  };

  // 视觉复核图表的中文标题映射
  const CHART_TITLES: Record<string, string> = {
    raw_coordinates: '原始坐标时序（N/E/U）',
    cumulative_displacement: '累计位移（相对首点，mm）',
    resultant_displacement: '合成位移（水平/三维，mm）',
  };

  // 渲染简约全量数据表格（带吸顶表头与独立顺畅滚动）
  const renderTableContent = () => {
    // 0a. 工具执行中：不展示任何结果形态，更不能显示“执行成功”
    if (toolCall.status === 'loading') {
      return (
        <div className="flex items-center gap-2 p-3 bg-neutral-50 border border-neutral-200/80 rounded-lg text-xs text-neutral-500">
          <Loader2 className="w-3.5 h-3.5 text-neutral-400 animate-spin shrink-0" />
          正在查询，请稍候…
        </div>
      );
    }
    // 0b. 视觉复核卡片：优先展示后端渲染的 PNG 图表（artifact），无图时兑底 SVG
    if (data?.chart_points && Array.isArray(data.chart_points)) {
      const obs = data.observations || {};
      const candidates: any[] = obs.candidates || [];
      const artifactImages = (toolCall.images || []).filter(
        (img) => img?.png_base64 && CHART_TITLES[img.name]
      );
      return (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px] text-neutral-400 px-0.5">
            <span>
              测点: <strong className="text-neutral-700">{data.station_name}</strong>
              （{data.begin_time?.slice(0, 10)} ~ {data.end_time?.slice(0, 10)}）
            </span>
            <span>
              {data.total_points ?? data.chart_points.length} 条数据 ·
              {artifactImages.length > 0
                ? ` ${artifactImages.length} 张分析图`
                : ` 展示 ${data.chart_points.length} 点`}
            </span>
          </div>

          {!data.ok && (
            <div className="px-2.5 py-1.5 bg-amber-50 border border-amber-200/70 rounded-md text-[11px] text-amber-700">
              {data.message || '视觉模型不可用，仅展示图表数据'}
            </div>
          )}

          {/* 后端渲染的分析图 PNG（原始时序 / 累计位移 / 合成位移） */}
          {artifactImages.length > 0 && (
            <div className="space-y-1.5">
              {artifactImages.map((img, i) => {
                const title = img.title || CHART_TITLES[img.name] || img.name;
                return (
                  <figure key={img.name} className="border border-neutral-200/90 rounded-lg bg-white shadow-sm overflow-hidden max-w-3xl">
                    <figcaption className="px-3 py-1.5 text-[11px] font-medium text-neutral-600 border-b border-neutral-100 bg-[#f9fafb]">
                      图{i + 1} · {title}
                    </figcaption>
                    <img
                      src={`data:image/png;base64,${img.png_base64}`}
                      alt={title}
                      className="w-full h-auto block"
                      loading="lazy"
                    />
                  </figure>
                );
              })}
            </div>
          )}

          {/* 兑底：无 artifact 图片时用 chart_points 渲染 SVG 迷你时序图 */}
          {artifactImages.length === 0 && (
            <div className="border border-neutral-200/90 rounded-lg bg-white p-3 shadow-sm space-y-2 max-w-3xl">
              {(['n', 'e', 'u'] as const).map((key) => {
                const label =
                  key === 'n' ? 'N 北向 (m)' : key === 'e' ? 'E 东向 (m)' : 'U 垂直 (m)';
                const chart = buildPolyline(data.chart_points, key);
                return (
                  <div key={key}>
                    <div className="flex items-center justify-between text-[10px] text-neutral-400 mb-0.5">
                      <span>{label}</span>
                      {chart && (
                        <span className="font-mono">
                          {chart.min.toFixed(3)} ~ {chart.max.toFixed(3)}
                        </span>
                      )}
                    </div>
                    {chart ? (
                      <svg
                        viewBox="0 0 100 100"
                        preserveAspectRatio="none"
                        className="w-full h-14 bg-neutral-50/80 border border-neutral-100 rounded"
                      >
                        {chart.lines.map((line, index) => (
                          <polyline
                            key={index}
                            points={line}
                            fill="none"
                            stroke="#2563eb"
                            strokeWidth="1.2"
                            vectorEffect="non-scaling-stroke"
                          />
                        ))}
                      </svg>
                    ) : (
                      <div className="h-14 flex items-center justify-center text-[10px] text-neutral-300 bg-neutral-50/80 border border-neutral-100 rounded">
                        无有效数据
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* 异常候选（高亮） */}
          {candidates.length > 0 && (
            <div className="border border-amber-200/80 rounded-lg bg-amber-50/60 p-2.5 max-w-3xl">
              <div className="text-[11px] font-semibold text-amber-700 mb-1.5 flex items-center gap-1">
                <Eye className="w-3.5 h-3.5" />形态异常候选（{candidates.length}）
              </div>
              <div className="space-y-1.5">
                {candidates.map((c: any, i: number) => (
                  <div key={i} className="text-xs text-neutral-800 bg-white/80 border border-amber-100 rounded-md px-2 py-1.5">
                    <div className="flex items-center gap-1.5 text-[10px] text-neutral-500">
                      <span className="px-1.5 py-0.5 bg-neutral-100 rounded font-mono">{c.metric}</span>
                      <span className="font-mono">
                        {String(c.start_at).slice(0, 16)} ~ {String(c.end_at).slice(5, 16)}
                      </span>
                    </div>
                    <div className="mt-1">{c.description || '（未描述）'}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 形态观察摘要 */}
          {(obs.fact_text || (obs.trends && obs.trends.length > 0) || (obs.turning_points && obs.turning_points.length > 0)) && (
            <div className="border border-neutral-200/90 rounded-lg bg-white p-3 shadow-sm max-w-3xl">
              {obs.fact_text && (
                <div className="text-xs text-neutral-800 leading-relaxed">{obs.fact_text}</div>
              )}
              {(obs.trends?.length > 0 || obs.turning_points?.length > 0) && (
                <ul className="mt-1.5 space-y-1">
                  {obs.trends?.map((t: string, i: number) => (
                    <li key={`t${i}`} className="text-[11px] text-neutral-600 flex gap-1.5">
                      <span className="text-neutral-300">•</span>
                      <span>趋势：{t}</span>
                    </li>
                  ))}
                  {obs.turning_points?.map((t: string, i: number) => (
                    <li key={`p${i}`} className="text-[11px] text-neutral-600 flex gap-1.5">
                      <span className="text-neutral-300">•</span>
                      <span>拐点：{t}</span>
                    </li>
                  ))}
                </ul>
              )}
              {obs.image_quality && (
                <div className="mt-1.5 text-[10px] text-neutral-400">图像质量：{obs.image_quality}</div>
              )}
            </div>
          )}
        </div>
      );
    }

    // 1. 天气摘要卡片 + 历史与预报按日降雨表
    if (data?.current && data?.rain_summary) {
      const loc = data.location || {};
      const cur = data.current || {};
      const rain = data.rain_summary || {};
      const wind = data.wind_summary || {};
      const hist = data.history?.daily || {};
      const fc = data.forecast?.daily || {};

      const histRain = new Map<string, number>();
      (hist.time || []).forEach((d: string, i: number) =>
        histRain.set(d, hist.precipitation_sum?.[i] ?? null)
      );
      const fcByDate = new Map<string, any>();
      (fc.time || []).forEach((d: string, i: number) =>
        fcByDate.set(d, {
          rain: fc.precipitation_sum?.[i],
          prob: fc.precipitation_probability_max?.[i],
          wind: fc.wind_speed_10m_max?.[i],
        })
      );
      const dates = [...new Set([...histRain.keys(), ...fcByDate.keys()])].sort();

      const cells: { label: string; value: string }[] = [
        {
          label: '最近 24 个完整小时降雨',
          value: rain.recent_24h_precipitation != null
            ? `${rain.recent_24h_precipitation} mm`
            : rain.recent_24h_window
              ? `数据不足（${rain.recent_24h_window.available_hours}/24 小时）`
              : '-',
        },
        {
          label: `历史合计降雨 (${data.query?.history_start_date || ''} ~ ${data.query?.history_end_date || ''})`,
          value: rain.history_total_precipitation != null ? `${rain.history_total_precipitation} mm` : '-',
        },
        {
          label: '历史最大日降雨',
          value: rain.history_max_daily_precipitation
            ? `${rain.history_max_daily_precipitation.date}: ${rain.history_max_daily_precipitation.value} mm`
            : '-',
        },
        {
          label: '预报合计降雨',
          value: rain.forecast_total_precipitation != null ? `${rain.forecast_total_precipitation} mm` : '-',
        },
        {
          label: '预报最大日降雨',
          value: rain.forecast_max_daily_precipitation
            ? `${rain.forecast_max_daily_precipitation.date}: ${rain.forecast_max_daily_precipitation.value} mm`
            : '-',
        },
        {
          label: '预报最大降水概率',
          value:
            rain.forecast_max_precipitation_probability != null
              ? `${rain.forecast_max_precipitation_probability}%`
              : '-',
        },
        {
          label: '当前风速 / 阵风',
          value:
            wind.current_wind_speed != null
              ? `${wind.current_wind_speed} / ${wind.current_wind_gust ?? '-'} km/h`
              : '-',
        },
        {
          label: '历史最大风速 / 阵风',
          value:
            wind.history_max_wind_speed != null
              ? `${wind.history_max_wind_speed} / ${wind.history_max_wind_gust ?? '-'} km/h`
              : '-',
        },
        {
          label: '预报最大风速 / 阵风',
          value:
            wind.forecast_max_wind_speed != null
              ? `${wind.forecast_max_wind_speed} / ${wind.forecast_max_wind_gust ?? '-'} km/h`
              : '-',
        },
      ];

      return (
        <div className="space-y-1.5">
          <div className="text-[11px] text-neutral-400 px-0.5">
            位置: {loc.station_name ? `${loc.station_name} · ` : ''}
            ({loc.latitude}, {loc.longitude})
            {(data.query?.timezone || loc.timezone) && ` · 时区：${data.query?.timezone || loc.timezone}`}
          </div>
          {rain.recent_24h_window && (
            <div className="text-[11px] text-neutral-400 px-0.5">
              降雨统计窗口：{rain.recent_24h_window.start_time} 至 {rain.recent_24h_window.end_time}
              （天气服务小时数据）
            </div>
          )}
          <div className="border border-neutral-200/90 rounded-lg bg-white p-3 shadow-sm max-w-3xl">
            <div className="flex items-center gap-2 text-sm text-neutral-800 font-medium">
              <CloudRain className="w-4 h-4 text-neutral-500" />
              <span>{cur.condition ?? '-'}</span>
              <span className="text-neutral-500 font-normal">
                {cur.temperature_2m ?? '-'}℃（体感 {cur.apparent_temperature ?? '-'}℃，湿度{' '}
                {cur.relative_humidity_2m ?? '-'}%）
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2.5 max-h-64 overflow-y-auto overscroll-contain">
              {cells.map((c, i) => (
                <div
                  key={i}
                  className="px-2.5 py-2 bg-neutral-50 border border-neutral-100 rounded-md"
                >
                  <div className="text-[10px] text-neutral-400">{c.label}</div>
                  <div className="text-xs text-neutral-800 font-mono mt-0.5">{c.value}</div>
                </div>
              ))}
            </div>
          </div>
          {dates.length > 0 && (
            <div className="border border-neutral-200/90 rounded-lg bg-white max-h-64 overflow-auto overscroll-contain shadow-sm">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="sticky top-0 z-10 bg-[#f9fafb] text-neutral-600 font-semibold border-b border-neutral-200/90 shadow-[0_1px_0_rgba(0,0,0,0.04)]">
                  <tr>
                    <th className="py-2 px-3 whitespace-nowrap">日期</th>
                    <th className="py-2 px-3 whitespace-nowrap">历史降雨 (mm)</th>
                    <th className="py-2 px-3 whitespace-nowrap">预报降雨 (mm)</th>
                    <th className="py-2 px-3 whitespace-nowrap">降水概率 (%)</th>
                    <th className="py-2 px-3 whitespace-nowrap">最大风速 (km/h)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100 text-neutral-800 font-mono text-[11px]">
                  {dates.map((d: string) => (
                    <tr key={d} className="hover:bg-neutral-50/70 transition-colors">
                      <td className="py-1 px-3 text-neutral-600 whitespace-nowrap">{d}</td>
                      <td className="py-1 px-3">{histRain.get(d) ?? '-'}</td>
                      <td className="py-1 px-3">{fcByDate.get(d)?.rain ?? '-'}</td>
                      <td className="py-1 px-3">{fcByDate.get(d)?.prob ?? '-'}</td>
                      <td className="py-1 px-3">{fcByDate.get(d)?.wind ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      );
    }

    // 1. 监测分组表格（展示全部数据，无截断）
    if (data?.groups && Array.isArray(data.groups)) {
      return (
        <div className="space-y-1">
          <div className="text-[11px] text-neutral-400 px-0.5">
            共查询到 {data.groups.length} 个监测分组
          </div>
          <div className="border border-neutral-200/90 rounded-lg bg-white max-h-64 overflow-auto overscroll-contain shadow-sm">
            <table className="w-full text-left text-xs border-collapse">
              <thead className="sticky top-0 z-10 bg-[#f9fafb] text-neutral-600 font-semibold border-b border-neutral-200/90 shadow-[0_1px_0_rgba(0,0,0,0.04)]">
                <tr>
                  <th className="py-2 px-3 whitespace-nowrap">分组名称</th>
                  <th className="py-2 px-3 whitespace-nowrap">监测点数</th>
                  <th className="py-2 px-3">分组说明</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 text-neutral-800">
                {data.groups.map((g: any, i: number) => (
                  <tr key={i} className="hover:bg-neutral-50/70 transition-colors">
                    <td className="py-2 px-3 font-medium text-neutral-900 whitespace-nowrap">{g.group_name}</td>
                    <td className="py-2 px-3 whitespace-nowrap">
                      <span className="inline-block px-1.5 py-0.5 bg-neutral-100 rounded text-neutral-700 text-[11px]">
                        {g.station_count ?? 0} 个测点
                      </span>
                    </td>
                    <td className="py-2 px-3 text-neutral-500">{g.description || '（无描述）'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    }

    // 2. 监测点列表表格（展示全部数据，无截断，支持纵向滚动查看几十上百测点）
    if (data?.stations && Array.isArray(data.stations)) {
      return (
        <div className="space-y-1">
          <div className="text-[11px] text-neutral-400 px-0.5">
            共查询到 {data.stations.length} 个监测点详情
          </div>
          <div className="border border-neutral-200/90 rounded-lg bg-white max-h-64 overflow-auto overscroll-contain shadow-sm">
            <table className="w-full text-left text-xs border-collapse">
              <thead className="sticky top-0 z-10 bg-[#f9fafb] text-neutral-600 font-semibold border-b border-neutral-200/90 shadow-[0_1px_0_rgba(0,0,0,0.04)]">
                <tr>
                  <th className="py-2 px-3 whitespace-nowrap">序号</th>
                  <th className="py-2 px-3 whitespace-nowrap">监测点名称</th>
                  <th className="py-2 px-3 whitespace-nowrap">当前状态</th>
                  <th className="py-2 px-3 whitespace-nowrap">所属分组 / 位置</th>
                  <th className="py-2 px-3 whitespace-nowrap">测点类型</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 text-neutral-800">
                {data.stations.map((s: any, i: number) => {
                  const statusStyles: Record<string, { dot: string; text: string }> = {
                    正常: { dot: 'bg-emerald-500', text: '正常' },
                    离线: { dot: 'bg-neutral-400', text: '离线' },
                    告警: { dot: 'bg-amber-500', text: '告警' },
                    故障: { dot: 'bg-red-500', text: '故障' },
                  };
                  const status = statusStyles[s.station_status] || {
                    dot: 'bg-neutral-300',
                    text: '未知',
                  };
                  return (
                    <tr key={i} className="hover:bg-neutral-50/70 transition-colors">
                      <td className="py-2 px-3 text-neutral-400 font-mono text-[11px]">{i + 1}</td>
                      <td className="py-2 px-3 font-mono font-medium text-neutral-900 whitespace-nowrap">
                        {s.station_name}
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] bg-neutral-100/90">
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              status.dot
                            }`}
                          />
                          <span className="text-neutral-700">{status.text}</span>
                        </span>
                      </td>
                      <td className="py-2 px-3 text-neutral-600">
                        {s.location || s.group_name || '-'}
                      </td>
                      <td className="py-2 px-3 text-neutral-400 text-[11px] whitespace-nowrap">
                        {typeof s.station_type === 'string' && s.station_type.trim()
                          ? s.station_type
                          : '未知'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      );
    }

    // 3. GNSS 时序数据表格（展示全部数据点，完全支持滚动查看全部数据）
    if (data?.points && Array.isArray(data.points)) {
      const allPoints = data.points;

      return (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] text-neutral-400 px-0.5">
            <span>
              测点: <strong className="text-neutral-700">{data.station_name || 'GNSS'}</strong>
            </span>
            <span>
              已加载 {allPoints.length} 条采样记录（共 {data.total_points ?? allPoints.length} 条
              {data.downsampled ? '，超限已等间隔降采样' : ''}，支持上下滚动）
            </span>
          </div>
          <div className="border border-neutral-200/90 rounded-lg bg-white h-56 max-h-56 overflow-y-auto overscroll-contain shadow-sm">
            <table className="w-full text-left text-xs border-collapse">
              <thead className="sticky top-0 z-10 bg-[#f9fafb] text-neutral-600 font-semibold border-b border-neutral-200/90 shadow-[0_1px_0_rgba(0,0,0,0.04)]">
                <tr>
                  <th className="py-2 px-3 whitespace-nowrap">#</th>
                  <th className="py-2 px-3 whitespace-nowrap">采样时刻</th>
                  <th className="py-2 px-3 whitespace-nowrap">北向坐标 N (m)</th>
                  <th className="py-2 px-3 whitespace-nowrap">东向坐标 E (m)</th>
                  <th className="py-2 px-3 whitespace-nowrap">垂直坐标 U (m)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 text-neutral-800 font-mono text-[11px]">
                {allPoints.map((p: any, i: number) => (
                  <tr key={i} className="hover:bg-neutral-50/70 transition-colors">
                    <td className="py-1 px-3 text-neutral-400">{i + 1}</td>
                    <td className="py-1 px-3 text-neutral-600 whitespace-nowrap">{p.time}</td>
                    <td className="py-1 px-3">{formatGnssValue(p.n)}</td>
                    <td className="py-1 px-3">{formatGnssValue(p.e)}</td>
                    <td className="py-1 px-3">{formatGnssValue(p.u)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    }

    // 4. 未知结果只作为二次折叠的技术详情，不进入默认业务展示。
    if (data && typeof data === 'object') {
      if (Object.keys(data).length > 0) {
        return (
          <details className="rounded-lg border border-neutral-200/90 bg-neutral-50 px-3 py-2 text-xs text-neutral-500">
            <summary className="cursor-pointer select-none font-medium">技术详情</summary>
            <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-neutral-700">
              {JSON.stringify(data, null, 2)}
            </pre>
          </details>
        );
      }
    }

    // 已完成但无可解析的数据内容：中性文案，不显示“执行成功”等状态词
    return (
      <div className="p-3 bg-neutral-50 border border-neutral-200/80 rounded-lg text-xs text-neutral-500">
        {data ? (
          <details>
            <summary className="cursor-pointer select-none font-medium">技术详情</summary>
            <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-[11px] text-neutral-700">{String(data)}</pre>
          </details>
        ) : (
          '该步骤已完成，无详细数据输出'
        )}
      </div>
    );
  };

  return (
    <div className="my-2 text-xs">
      {/* 极简单行触发条：图标 + 文案 + 右侧小箭头（类似“运行了命令”） */}
      <div
        onClick={() => setExpanded(!expanded)}
        className="inline-flex items-center gap-1.5 py-1 px-2 -ml-1 rounded-md text-neutral-500 hover:text-neutral-800 hover:bg-neutral-100/80 cursor-pointer transition-colors select-none"
      >
        {renderIcon()}
        <span className="font-normal">{getActionText()}</span>
        <ChevronRight
          className={`w-3.5 h-3.5 text-neutral-400 transition-transform duration-200 ${
            expanded ? 'rotate-90 text-neutral-600' : ''
          }`}
        />
      </div>

      {/* 展开后的全量数据表格区域：外层统一限制高度（任何工具结果都不会撑破界面），
          内部各表格自带 max-h 滚动与吸顶表头 */}
      {expanded && (
        <div
          className={`mt-1.5 max-w-3xl ${
            toolCall.siteEnvironment
              ? ''
              : 'max-h-[28rem] overflow-y-auto overscroll-contain animate-in fade-in duration-150'
          }`}
        >
          {toolCall.siteEnvironment ? (
            <ErrorBoundary fallbackTitle="现场环境地图渲染异常">
              <React.Suspense
                fallback={<div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-500">正在加载地图组件…</div>}
              >
                <SiteEnvironmentCard environment={toolCall.siteEnvironment} />
              </React.Suspense>
            </ErrorBoundary>
          ) : (
            renderTableContent()
          )}
        </div>
      )}
    </div>
  );
};
