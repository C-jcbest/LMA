interface MapMarkerContent {
  name: string;
  detail: string;
  colorToken: string;
  reference?: boolean;
  current?: boolean;
}

interface MapPopupContent {
  name: string;
  context: string;
  stationType?: string | null;
  colorToken: string;
  status?: string | null;
  reason?: string | null;
  metric?: { label: string; value: string; unit: string; direction: string | null };
  fields: Array<{ label: string; value: string; wide?: boolean }>;
  note?: string;
  action?: { label: string; run: () => void };
  onClose: () => void;
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
  element.style.height = `${arrow.lengthPixels}px`;
  element.style.transform = `rotate(${arrow.azimuth}deg)`;
}

export function setMarkerDetail(node: HTMLElement, detail: string) {
  const value = node.querySelector('.evidence-map-marker__value');
  if (value) {
    value.textContent = detail;
  }
}

export function createMapMarker(content: MapMarkerContent) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'evidence-map-marker';
  node.style.setProperty('--marker-color', `var(${content.colorToken})`);
  node.dataset.reference = String(Boolean(content.reference));
  node.dataset.current = String(Boolean(content.current));
  node.setAttribute('aria-label', `${content.name}，${content.detail}`);
  const dot = document.createElement('span');
  dot.className = 'evidence-map-marker__dot';
  const label = document.createElement('span');
  label.className = 'evidence-map-marker__label';
  label.append(
    textElement('span', 'evidence-map-marker__name', content.name),
    textElement('span', 'evidence-map-marker__value', content.detail),
  );
  node.append(dot, label);
  return node;
}

/** 标签留在地图内，避开其他测点点位、位移箭头和已放置标签。 */
export function placeMapMarkerLabels(map: AMap.Map, container: HTMLElement, markers: Array<{ marker: AMap.Marker; element: HTMLElement }>) {
  if (container.clientWidth === 0 || container.clientHeight === 0) {
    return;
  }
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
  const arrowBoxes = markers.map(({ element }, index) => {
    const point = positions[index];
    const arrow = element.querySelector<HTMLElement>('.evidence-map-marker__arrow');
    if (!point || !arrow) {
      return null;
    }
    const match = arrow.style.transform.match(/rotate\(([-0-9.]+)deg\)/);
    const angleDeg = match ? Number(match[1]) : NaN;
    const len = parseFloat(arrow.style.height);
    if (!Number.isFinite(angleDeg) || !Number.isFinite(len) || len <= 0) {
      return null;
    }
    const rad = (angleDeg * Math.PI) / 180;
    const tipX = point.x + Math.sin(rad) * (len + 6);
    const tipY = point.y - Math.cos(rad) * (len + 6);
    return {
      left: Math.min(point.x, tipX) - 8,
      right: Math.max(point.x, tipX) + 8,
      top: Math.min(point.y, tipY) - 8,
      bottom: Math.max(point.y, tipY) + 8,
    };
  });
  const placed: Array<{ left: number; top: number; right: number; bottom: number }> = [];
  for (const [index, { element }] of markers.entries()) {
    const label = element.querySelector<HTMLElement>('.evidence-map-marker__label');
    const point = positions[index];
    if (!label || !point) {
      continue;
    }
    label.style.maxWidth = `${Math.max(64, Math.min(168, container.clientWidth - 32))}px`;
    const width = label.offsetWidth;
    const height = label.offsetHeight;
    const candidates = [
      { left: point.x + 16, top: point.y - height / 2 },
      { left: point.x - 16 - width, top: point.y - height / 2 },
      { left: point.x - width / 2, top: point.y + 26 },
      { left: point.x - width / 2, top: point.y - height - 26 },
      { left: point.x + 18, top: point.y - height - 18 },
      { left: point.x - 18 - width, top: point.y - height - 18 },
      { left: point.x + 18, top: point.y + 18 },
      { left: point.x - 18 - width, top: point.y + 18 },
      { left: point.x - width / 2, top: point.y - height - 48 },
      { left: point.x - width / 2, top: point.y + 48 },
    ];
    let chosen = candidates[0]!;
    let bestScore = Infinity;
    let blocksMarker = false;
    for (const candidate of candidates) {
      const right = candidate.left + width;
      const bottom = candidate.top + height;
      const outside = candidate.left < 8 || right > container.clientWidth - 8 || candidate.top < 8 || bottom > container.clientHeight - 8;
      const coversMarker = positions.some((other, otherIndex) => other && otherIndex !== index
        && other.x + 22 > candidate.left && other.x - 22 < right
        && other.y + 22 > candidate.top && other.y - 22 < bottom);
      const coversArrow = arrowBoxes.some((box) => box
        && box.right > candidate.left && box.left < right
        && box.bottom > candidate.top && box.top < bottom);
      const overlapsLabel = placed.some((other) => other.right + 4 > candidate.left && other.left - 4 < right
        && other.bottom + 4 > candidate.top && other.top - 4 < bottom);
      const score = Number(outside) * 1000 + Number(coversMarker) * 150 + Number(coversArrow) * 80 + Number(overlapsLabel) * 20;
      if (score < bestScore) {
        chosen = candidate;
        bestScore = score;
        blocksMarker = coversMarker;
      }
    }
    label.style.left = `${element.clientWidth / 2 + chosen.left - point.x}px`;
    label.style.top = `${element.clientHeight / 2 + chosen.top - point.y}px`;
    label.style.transform = 'none';
    label.style.pointerEvents = blocksMarker ? 'none' : '';
    placed.push({ ...chosen, right: chosen.left + width, bottom: chosen.top + height });
  }
}

export function createMapPopup(content: MapPopupContent, mapContainer: HTMLElement) {
  const node = document.createElement('section');
  node.className = 'map-station-popup';
  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'touchmove', 'wheel']) {
    node.addEventListener(type, (event) => event.stopPropagation());
  }
  node.style.setProperty('--marker-color', `var(${content.colorToken})`);
  node.style.width = `${Math.min(280, mapContainer.clientWidth - 24)}px`;
  node.style.maxHeight = `${Math.min(390, mapContainer.clientHeight - 48)}px`;
  node.setAttribute('aria-label', `${content.name} 测点信息`);
  const header = document.createElement('header');
  header.className = 'map-station-popup__header';
  const identity = document.createElement('div');
  identity.append(
    textElement('div', 'map-station-popup__context', content.context),
    textElement('h3', 'map-station-popup__name', content.name),
  );
  if (content.stationType) {
    identity.append(textElement('span', 'map-station-popup__type', content.stationType));
  }
  const close = textElement('button', 'map-station-popup__close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', '关闭测点信息');
  close.addEventListener('click', content.onClose);
  header.append(identity, close);
  node.append(header);
  const body = document.createElement('div');
  body.className = 'map-station-popup__body';
  node.append(body);
  if (content.status) {
    const status = textElement('div', 'map-station-popup__status', content.status);
    body.append(status);
  }
  if (content.reason) {
    body.append(textElement('p', 'map-station-popup__reason', content.reason));
  }
  if (content.metric) {
    const metric = document.createElement('div');
    metric.className = 'map-station-popup__metric';
    metric.append(textElement('div', 'map-station-popup__metric-label', content.metric.label));
    const value = textElement('div', 'map-station-popup__metric-value', content.metric.value);
    value.append(textElement('span', 'map-station-popup__metric-unit', content.metric.unit));
    metric.append(value);
    if (content.metric.direction) {
      metric.append(textElement('div', 'map-station-popup__direction', content.metric.direction));
    }
    body.append(metric);
  }
  if (content.fields.length > 0) {
    const fields = document.createElement('dl');
    fields.className = 'map-station-popup__fields';
    for (const field of content.fields) {
      const row = document.createElement('div');
      if (field.wide) {
        row.className = 'map-station-popup__field-wide';
      }
      row.append(textElement('dt', '', field.label), textElement('dd', '', field.value));
      fields.append(row);
    }
    body.append(fields);
  }
  if (content.note) {
    body.append(textElement('p', 'map-station-popup__note', content.note));
  }
  if (content.action) {
    const action = textElement('button', 'map-station-popup__action', content.action.label);
    action.type = 'button';
    action.addEventListener('click', content.action.run);
    node.append(action);
  }
  return node;
}
