import http from 'node:http';

const port = 19090;
let responseSequence = 0;

const json = (response, payload, status = 200) => {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
};

const messageText = (message) => {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text ?? '')
    .join('');
};

const chatResponse = (content) => ({
  id: `e2e-${++responseSequence}`,
  object: 'chat.completion',
  created: 1,
  model: 'lma-e2e-model',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 80, completion_tokens: 12, total_tokens: 92 },
});

const toolResponse = (name, args) => ({
  id: `e2e-${++responseSequence}`,
  object: 'chat.completion',
  created: 1,
  model: 'lma-e2e-model',
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: `call-${responseSequence}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      }],
    },
    finish_reason: 'tool_calls',
  }],
  usage: { prompt_tokens: 80, completion_tokens: 12, total_tokens: 92 },
});

const streamChat = async (response, payload, delayMs = 0) => {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'close',
  });
  const message = payload.choices[0].message;
  const deltas = message.tool_calls
    ? [{ role: 'assistant', content: '', tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) }]
    : [...message.content].map((content, index) => index === 0 ? { role: 'assistant', content } : { content });

  for (const delta of deltas) {
    if (response.destroyed) return;
    response.write(`data: ${JSON.stringify({
      id: payload.id,
      object: 'chat.completion.chunk',
      created: 1,
      model: payload.model,
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\n`);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (response.destroyed) return;
  response.write(`data: ${JSON.stringify({
    id: payload.id,
    object: 'chat.completion.chunk',
    created: 1,
    model: payload.model,
    choices: [{
      index: 0,
      delta: {},
      finish_reason: message.tool_calls ? 'tool_calls' : 'stop',
    }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: payload.id,
    object: 'chat.completion.chunk',
    created: 1,
    model: payload.model,
    choices: [],
    usage: payload.usage,
  })}\n\ndata: [DONE]\n\n`);
  response.end();
};

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    return json(response, { ok: true });
  }

  let rawBody = '';
  for await (const chunk of request) rawBody += chunk;
  const body = rawBody ? JSON.parse(rawBody) : {};

  if (request.url?.endsWith('/UserLogin/doLogin.php')) {
    return json(response, { ResponseCode: '200', SessionUUID: 'INVALID_E2E_SESSION' });
  }
  if (request.url?.endsWith('/Station/getStationGroupListInfo.php')) {
    return json(response, {
      ResponseCode: '200',
      StationGroupList: [{
        StationGroupUUID: 'e2e-group',
        StationGroupName: 'E2E 监测组',
        StationCount: 1,
      }],
    });
  }
  if (request.url?.endsWith('/Station/getStationListInfo.php')) {
    const stations = String(body.StationName ?? '').includes('不存在') ? [] : [{
      StationGroupUUID: 'e2e-group',
      StationGroupName: 'E2E 监测组',
      StationUUID: '11111111-1111-1111-1111-111111111111',
      StationName: 'E2E空数据站',
      StationType: 2,
      StationStatus: 10,
      StationLocation: '测试场地',
      Latitude: '30.1',
      Longitude: '120.2',
      Altitude: '12.3',
    }];
    return json(response, { ResponseCode: '200', StationList: stations });
  }
  if (request.url?.endsWith('/GNSSData/getDailyGNSSDataInfo.php')) {
    return json(response, { ResponseCode: '200', Data: [] });
  }

  if (!request.url?.endsWith('/v1/chat/completions')) {
    return json(response, { error: 'unknown e2e endpoint' }, 404);
  }

  const messages = body.messages ?? [];
  const firstText = messageText(messages[0]);
  const lastUserIndex = messages.map((message) => message.role).lastIndexOf('user');
  const userText = lastUserIndex >= 0 ? messageText(messages[lastUserIndex]) : '';
  const hasToolResult = messages.slice(lastUserIndex + 1).some((message) => message.role === 'tool');

  let payload;
  let delayMs = 0;
  if (firstText.startsWith('Create a concise conversation title')) {
    payload = chatResponse('E2E 生命周期验证');
  } else if (userText.includes('不存在监测点') && !hasToolResult) {
    payload = toolResponse('get_daily_gnss_data', {
      station_name_or_uuid: '不存在监测点',
      begin_time: '2026-09-01 00:00:00',
      end_time: '2026-09-02 00:00:00',
    });
  } else if (userText.includes('空结果监测点') && !hasToolResult) {
    payload = toolResponse('get_daily_gnss_data', {
      station_name_or_uuid: 'E2E空数据站',
      begin_time: '2026-09-01 00:00:00',
      end_time: '2026-09-02 00:00:00',
    });
  } else if (userText.includes('慢速')) {
    payload = chatResponse('慢速生成已完成，切换会话后状态与内容保持一致。');
    delayMs = 160;
  } else if (hasToolResult) {
    payload = chatResponse(userText.includes('不存在')
      ? '未取得该监测点数据，已保留工具错误证据。'
      : '查询完成；该时段没有 GNSS 数据，不能据此判断形变。');
  } else if (userText.includes('分支重试')) {
    payload = chatResponse(`分支回答版本 ${++responseSequence}`);
  } else {
    payload = chatResponse(`已继续处理：${userText || '测试消息'}`);
  }

  if (body.stream) return streamChat(response, payload, delayMs);
  return json(response, payload);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`E2E stub listening on http://127.0.0.1:${port}\n`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
