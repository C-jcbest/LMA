interface MapMarkerContent {
  name: string;
  detail?: string;
  colorToken: string;
  reference?: boolean;
  current?: boolean;
  priority?: number;
}

export interface PlaceableMarker {
  marker: AMap.Marker;
  element: HTMLElement;
  id?: string;
  priority?: number;
  isPrimary?: boolean;
}

function textElement<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text: string) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

const DIRECTIONS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];

export const directionName = (azimuth: number) => DIRECTIONS[Math.round(azimuth / 45) % DIRECTIONS.length]!;

export const directionText = (azimuth: number) => `${directionName(azimuth)}（方位 ${Math.round(azimuth)}°）`;

export const azimuthOf = (north: number, east: number) =>
  (Math.atan2(east, north) * (180 / Math.PI) + 360) % 360;

export const azimuthDifference = (first: number, second: number) => {
  const difference = Math.abs(first - second) % 360;
  return difference > 180 ? 360 - difference : difference;
};

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export function appendDownslopeFan(node: HTMLElement, azimuth: number) {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', '0 0 80 80');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('evidence-map-marker__slope');
  svg.style.transform = `translate(-50%, -50%) rotate(${azimuth}deg)`;
  const wedge = document.createElementNS(SVG_NAMESPACE, 'path');
  wedge.setAttribute('d', 'M40 40 L26.99 8.59 A34 34 0 0 1 53.01 8.59 Z');
  svg.append(wedge);
  node.prepend(svg);
}

export function setDisplacementArrow(node: HTMLElement, arrow: { azimuth: number; lengthPixels: number } | null) {
  let element = node.querySelector<HTMLElement>('.evidence-map-marker__arrow');
  if (!arrow) {
    element?.remove();
    return;
  }
  if (!element) {
    element = document.createElement('span');
    element.className = 'evidence-map-marker__arrow';
    node.append(element);
  }
  const previous = Number(element.dataset.azimuth);
  let targetAngle = arrow.azimuth;
  if (Number.isFinite(previous)) {
    const delta = ((arrow.azimuth - previous + 540) % 360) - 180;
    targetAngle = previous + delta;
  }
  element.dataset.azimuth = String(targetAngle);
  element.style.height = `${arrow.lengthPixels}px`;
  element.style.transform = `rotate(${targetAngle}deg)`;
}

export function setMarkerDetail(node: HTMLElement, detail: string) {
  const value = node.querySelector<HTMLElement>('.evidence-map-marker__value');
  if (!value) return;
  value.textContent = detail;
  value.hidden = !detail;
}

export function createMapMarker(content: MapMarkerContent) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'evidence-map-marker';
  node.style.setProperty('--marker-color', `var(${content.colorToken})`);
  node.dataset.reference = String(Boolean(content.reference));
  node.dataset.current = String(Boolean(content.current));
  const detail = content.detail?.trim() ?? '';
  node.setAttribute('aria-label', detail ? `${content.name}，${detail}` : content.name);
  const dot = document.createElement('span');
  dot.className = 'evidence-map-marker__dot';
  const label = document.createElement('span');
  label.className = 'evidence-map-marker__label';
  const swatch = document.createElement('span');
  swatch.className = 'evidence-map-marker__swatch';
  swatch.setAttribute('aria-hidden', 'true');
  const value = textElement('span', 'evidence-map-marker__value', detail);
  value.hidden = !detail;
  const clusterBadge = textElement('span', 'evidence-map-marker__cluster', '');
  clusterBadge.hidden = true;
  label.append(
    swatch,
    textElement('span', 'evidence-map-marker__name', content.name),
    value,
    clusterBadge,
  );
  node.append(dot, label);
  return node;
}

const CLUSTER_RADIUS_PX = 26;

/** 标签留在地图内，对屏幕近距重合测点自动聚类并裁剪重叠次要标签；批量读后再批量写避免重排。 */
export function placeMapMarkerLabels(map: AMap.Map, container: HTMLElement, markers: PlaceableMarker[]) {
  const containerWidth = container.clientWidth;
  const containerHeight = container.clientHeight;
  if (containerWidth === 0 || containerHeight === 0) {
    return;
  }

  // Phase 1: pure reads
  const positions = markers.map(({ marker }) => {
    try {
      const point = map.lngLatToContainer(marker.getPosition()!);
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        return null;
      }
      return point;
    } catch {
      return null;
    }
  });

  // Reset cluster visibility state before measuring labels
  const measurements = markers.map(({ element, id, priority = 0, isPrimary = true }, index) => {
    const label = element.querySelector<HTMLElement>('.evidence-map-marker__label');
    const arrow = element.querySelector<HTMLElement>('.evidence-map-marker__arrow');
    const clusterBadge = element.querySelector<HTMLElement>('.evidence-map-marker__cluster');
    const point = positions[index];
    if (!label || !point) {
      return null;
    }
    let arrowBox: { left: number; right: number; top: number; bottom: number } | null = null;
    if (arrow) {
      const angleDeg = Number(arrow.dataset.azimuth ?? arrow.style.transform.match(/rotate\(([-0-9.]+)deg\)/)?.[1]);
      const len = parseFloat(arrow.style.height);
      if (Number.isFinite(angleDeg) && Number.isFinite(len) && len > 0) {
        const rad = (angleDeg * Math.PI) / 180;
        const tipX = point.x + Math.sin(rad) * (len + 6);
        const tipY = point.y - Math.cos(rad) * (len + 6);
        arrowBox = {
          left: Math.min(point.x, tipX) - 8,
          right: Math.max(point.x, tipX) + 8,
          top: Math.min(point.y, tipY) - 8,
          bottom: Math.max(point.y, tipY) + 8,
        };
      }
    }
    return {
      index,
      id,
      priority,
      isPrimary,
      element,
      label,
      clusterBadge,
      point,
      elementWidth: element.clientWidth,
      elementHeight: element.clientHeight,
      width: label.offsetWidth,
      height: label.offsetHeight,
      arrowBox,
    };
  });

  // Phase 2: proximity clustering (highest-priority marker becomes cluster leader)
  const validItems = measurements
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => b.priority - a.priority || a.index - b.index);

  const clusterMembers = new Map<number, number[]>();
  const hiddenByCluster = new Set<number>();

  for (const item of validItems) {
    if (hiddenByCluster.has(item.index)) continue;
    const members = [item.index];
    for (const other of validItems) {
      if (other.index === item.index || hiddenByCluster.has(other.index)) continue;
      if (Math.hypot(other.point.x - item.point.x, other.point.y - item.point.y) < CLUSTER_RADIUS_PX) {
        members.push(other.index);
        hiddenByCluster.add(other.index);
      }
    }
    clusterMembers.set(item.index, members);
  }

  const visibleItems = validItems.filter((item) => !hiddenByCluster.has(item.index));
  const visiblePositions = visibleItems.map((item) => ({ index: item.index, x: item.point.x, y: item.point.y }));
  const visibleArrowBoxes = visibleItems.map((item) => item.arrowBox);

  // Phase 3: label placement & collision pruning
  const placed: Array<{ left: number; top: number; right: number; bottom: number }> = [];
  const labelWrites: Array<{
    item: (typeof visibleItems)[number];
    left: number;
    top: number;
    blocksMarker: boolean;
    hideLabel: boolean;
    clusterCount: number;
    memberIds: string[];
  }> = [];

  for (const item of visibleItems) {
    const { point, width, height, elementWidth, elementHeight, index, isPrimary } = item;
    const members = clusterMembers.get(index) ?? [index];
    const clusterCount = members.length;
    const badgeVisible = Boolean(item.clusterBadge && !item.clusterBadge.hidden);
    const extraWidth = clusterCount > 1 && !badgeVisible ? 26 : 0;
    const effectiveWidth = width + extraWidth;
    const candidates = [
      { left: point.x + 14, top: point.y - height / 2 },
      { left: point.x - 14 - effectiveWidth, top: point.y - height / 2 },
      { left: point.x - effectiveWidth / 2, top: point.y + 18 },
      { left: point.x - effectiveWidth / 2, top: point.y - height - 18 },
      { left: point.x + 14, top: point.y - height - 14 },
      { left: point.x - 14 - effectiveWidth, top: point.y - height - 14 },
      { left: point.x + 14, top: point.y + 14 },
      { left: point.x - 14 - effectiveWidth, top: point.y + 14 },
      { left: point.x - effectiveWidth / 2, top: point.y - height - 38 },
      { left: point.x - effectiveWidth / 2, top: point.y + 38 },
    ];
    let chosen = candidates[0]!;
    let bestScore = Infinity;
    let blocksMarker = false;
    let overlapsPlacedLabel = false;
    for (const candidate of candidates) {
      const right = candidate.left + effectiveWidth;
      const bottom = candidate.top + height;
      const outside = candidate.left < 8 || right > containerWidth - 8 || candidate.top < 46 || bottom > containerHeight - 12;
      const coversMarker = visiblePositions.some((other) => other.index !== index
        && other.x + 18 > candidate.left && other.x - 18 < right
        && other.y + 18 > candidate.top && other.y - 18 < bottom);
      const coversArrow = visibleArrowBoxes.some((box) => box
        && box.right > candidate.left && box.left < right
        && box.bottom > candidate.top && box.top < bottom);
      const overlapsLabel = placed.some((other) => other.right + 4 > candidate.left && other.left - 4 < right
        && other.bottom + 4 > candidate.top && other.top - 4 < bottom);
      const score = Number(outside) * 1000 + Number(overlapsLabel) * 240 + Number(coversMarker) * 180 + Number(coversArrow) * 80;
      if (score < bestScore) {
        chosen = candidate;
        bestScore = score;
        blocksMarker = coversMarker;
        overlapsPlacedLabel = overlapsLabel;
      }
    }
    const hideLabel = !isPrimary && clusterCount === 1 && (blocksMarker || overlapsPlacedLabel);
    const memberIds = members.map((memberIdx) => measurements[memberIdx]?.id).filter((value): value is string => Boolean(value));
    labelWrites.push({
      item,
      left: elementWidth / 2 + chosen.left - point.x,
      top: elementHeight / 2 + chosen.top - point.y,
      blocksMarker,
      hideLabel,
      clusterCount,
      memberIds,
    });
    if (!hideLabel) {
      placed.push({ ...chosen, right: chosen.left + effectiveWidth, bottom: chosen.top + height });
    }
  }

  // Phase 4: pure writes
  for (const item of validItems) {
    if (hiddenByCluster.has(item.index)) {
      item.element.dataset.clustered = 'hidden';
      delete item.element.dataset.clusterIds;
      item.element.tabIndex = -1;
      item.element.setAttribute('aria-hidden', 'true');
    } else {
      delete item.element.dataset.clustered;
      item.element.tabIndex = 0;
      item.element.removeAttribute('aria-hidden');
    }
  }

  for (const write of labelWrites) {
    const { item, left, top, blocksMarker, hideLabel, clusterCount, memberIds } = write;
    if (clusterCount > 1) {
      item.element.dataset.clustered = 'leader';
      item.element.dataset.clusterIds = memberIds.join(',');
      if (item.clusterBadge) {
        item.clusterBadge.textContent = `+${clusterCount - 1}`;
        item.clusterBadge.hidden = false;
      }
    } else {
      delete item.element.dataset.clusterIds;
      if (item.clusterBadge) {
        item.clusterBadge.textContent = '';
        item.clusterBadge.hidden = true;
      }
    }
    item.label.dataset.collapsed = hideLabel ? 'true' : 'false';
    item.label.style.left = `${left}px`;
    item.label.style.top = `${top}px`;
    item.label.style.transform = 'none';
    item.label.style.pointerEvents = blocksMarker || hideLabel ? 'none' : '';
  }
}
