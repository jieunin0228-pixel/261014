// Claude API 호출(서버에서만). API 키는 .env 의 ANTHROPIC_API_KEY 로만 읽고 브라우저에는 보내지 않습니다.
// 시험용으로 setCaller() 로 호출 함수를 바꿀 수 있고, COVERAGE_AI_FAKE=<폴더> 이면 그 폴더의 "<담보명>.json" 을 응답으로 씁니다.
const fs = require('fs');
const path = require('path');

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.CLAUDE_EFFORT || 'high';

let client = null;
let override = null;

function aiStatus() {
  if (override) return { ready: true, mode: 'test', model: 'test' };
  if (process.env.COVERAGE_AI_FAKE) return { ready: true, mode: 'fake', model: 'fake' };
  const ready = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  return { ready, mode: 'claude', model: MODEL, message: ready ? '' : 'API 키가 설정되지 않았습니다. README의 "API 키 설정"을 따라 .env 파일에 ANTHROPIC_API_KEY를 넣은 뒤 앱을 다시 실행해 주십시오.' };
}

function friendlyError(err, Anthropic) {
  if (Anthropic && err instanceof Anthropic.AuthenticationError) return 'API 키가 올바르지 않습니다. .env 파일의 ANTHROPIC_API_KEY를 확인해 주십시오.';
  if (Anthropic && err instanceof Anthropic.PermissionDeniedError) return 'API 키에 이 모델을 쓸 권한이 없습니다.';
  if (Anthropic && err instanceof Anthropic.RateLimitError) return '요청이 많아 잠시 제한되었습니다. 1~2분 뒤 다시 분석해 주십시오.';
  if (Anthropic && err instanceof Anthropic.BadRequestError) return `요청이 거부되었습니다: ${err.message}`;
  if (Anthropic && err instanceof Anthropic.APIConnectionError) return 'Claude API에 연결하지 못했습니다. 인터넷 연결과 사내 프록시 설정을 확인해 주십시오(README의 "문제 해결" 참고).';
  if (Anthropic && err instanceof Anthropic.APIError) return `Claude API 오류(${err.status}): ${err.message}`;
  return err.message;
}

// 반환: { json, usage, model }
async function callClaude({ system, documentText, request, schema, signal }) {
  const Anthropic = require('@anthropic-ai/sdk');
  client ||= new Anthropic();
  try {
    // 긴 응답이 시간 제한에 걸리지 않도록 스트리밍으로 받고 마지막에 한 번에 모읍니다.
    // 안전 분류기가 거절하면 서버가 기본 대체 모델로 다시 시도합니다(fallbacks: "default").
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: EFFORT, format: { type: 'json_schema', schema } },
      // 지시문(코드마스터 포함)과 약관 원문은 같은 약관의 여러 담보를 분석할 때 그대로 재사용되므로 캐시합니다.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: documentText, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: request },
        ],
      }],
    }, { signal });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new Error('Claude가 이 요청에 대한 응답을 거절했습니다. 다시 분석하거나 담보를 나눠 분석해 주십시오.');
    if (msg.stop_reason === 'max_tokens') throw new Error('응답이 너무 길어 중간에 끊겼습니다. 다시 분석해 주십시오.');
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let json;
    try { json = JSON.parse(text); } catch { throw new Error('Claude 응답을 읽지 못했습니다(형식 오류). 다시 분석해 주십시오.'); }
    return { json, usage: msg.usage, model: msg.model };
  } catch (err) {
    if (err.name === 'AbortError' || (signal && signal.aborted)) throw Object.assign(new Error('분석을 중지했습니다.'), { aborted: true });
    throw new Error(friendlyError(err, Anthropic));
  }
}

async function callFake({ coverageName }) {
  const file = path.join(process.env.COVERAGE_AI_FAKE, `${coverageName}.json`);
  if (!fs.existsSync(file)) throw new Error(`시험용 응답 파일이 없습니다: ${path.basename(file)}`);
  return { json: JSON.parse(fs.readFileSync(file, 'utf8')), usage: null, model: 'fake' };
}

function call(args) {
  if (override) return override(args);
  if (process.env.COVERAGE_AI_FAKE) return callFake(args);
  return callClaude(args);
}

module.exports = { call, aiStatus, setCaller: (fn) => { override = fn; }, MODEL };
