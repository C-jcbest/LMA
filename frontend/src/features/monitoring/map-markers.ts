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

// 测点名称、地址与调查原因来自外部数据，只作为文本写入，不拼接 HTML。
function textElement<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text: string) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

/** 两处地图采用同一套测点标记：小锚点表示真实位置，标签提供可扫读的信息。 */
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

/** 标签留在地图内，并避开其他测点的触屏点击区域；不改变测点的真实坐标。 */
export function placeMapMarkerLabels(map: AMap.Map, container: HTMLElement, markers: Array<{ marker: AMap.Marker; element: HTMLElement }>) {
  const positions = markers.map(({ marker }) => map.lngLatToContainer(marker.getPosition()!));
  const placed: Array<{ left: number; top: number; right: number; bottom: number }> = [];
  for (const [index, { element }] of markers.entries()) {
    const label = element.querySelector<HTMLElement>('.evidence-map-marker__label');
    if (!label) {
      continue;
    }
    const point = positions[index]!;
    label.style.maxWidth = `${Math.max(64, Math.min(168, container.clientWidth - 32))}px`;
    const width = label.offsetWidth;
    const height = label.offsetHeight;
    const candidates = [
      { left: point.x + 16, top: point.y - height / 2 },
      { left: point.x - 16 - width, top: point.y - height / 2 },
      { left: point.x - width / 2, top: point.y + 26 },
      { left: point.x - width / 2, top: point.y - height - 26 },
    ];
    let chosen = candidates[0]!;
    let bestScore = Infinity;
    let blocksMarker = false;
    for (const candidate of candidates) {
      const right = candidate.left + width;
      const bottom = candidate.top + height;
      const outside = candidate.left < 8 || right > container.clientWidth - 8 || candidate.top < 8 || bottom > container.clientHeight - 8;
      const coversMarker = positions.some((other, otherIndex) => otherIndex !== index
        && other.x + 22 > candidate.left && other.x - 22 < right
        && other.y + 22 > candidate.top && other.y - 22 < bottom);
      const overlapsLabel = placed.some((other) => other.right > candidate.left && other.left < right
        && other.bottom > candidate.top && other.top < bottom);
      // 优先留在地图内，其次保证点位可点击，最后减少标签互相覆盖。
      const score = Number(outside) * 1000 + Number(coversMarker) * 100 + Number(overlapsLabel) * 10;
      if (score < bestScore) {
        chosen = candidate;
        bestScore = score;
        blocksMarker = coversMarker;
      }
    }
    label.style.left = `${element.clientWidth / 2 + chosen.left - point.x}px`;
    label.style.top = `${element.clientHeight / 2 + chosen.top - point.y}px`;
    label.style.transform = 'none';
    // 极密集点位无法完全避让时，标签不拦截下面测点的点击。
    label.style.pointerEvents = blocksMarker ? 'none' : '';
    placed.push({ ...chosen, right: chosen.left + width, bottom: chosen.top + height });
  }
}

/** 高德自定义信息窗的内容；只组织已有资料，不在地图上补造调查结论。 */
export function createMapPopup(content: MapPopupContent, mapContainer: HTMLElement) {
  const node = document.createElement('section');
  node.className = 'map-station-popup';
  // 信息卡内的滚动和按钮操作不交给底下的地图手势处理。
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
