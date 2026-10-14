// 화면 ↔ 로컬 서버 통신(로컬 실행판). 아티팩트판은 같은 이름(CoverageApi)의 브라우저 전용 구현을 씁니다.
(function () {
  'use strict';

  // 업로드하고 분석이 끝날 때까지 기다립니다. onProgress(비율 0~1, 안내 문구)
  function analyze(file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.setRequestHeader('Content-Type', 'application/pdf');
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total * 0.1, `PDF를 올리는 중입니다. (${Math.round(e.loaded / e.total * 100)}%)`); };
      xhr.onerror = () => reject(new Error('업로드 중 연결이 끊겼습니다. 앱이 실행 중인지 확인해 주십시오.'));
      xhr.onload = () => {
        let res = {};
        try { res = JSON.parse(xhr.responseText); } catch { /* 빈 응답 */ }
        if (xhr.status !== 200) return reject(new Error(res.error || '업로드에 실패했습니다.'));
        if (res.cached) return resolve(res);
        followStructure(res.id, onProgress).then(() => resolve(res), reject);
      };
      xhr.send(file);
    });
  }

  async function list() {
    return (await fetch('/api/docs')).json();
  }

  // SSE 로 1단계 분석 진행 상황을 받다가 끝나면 돌아옵니다.
  function followStructure(id, onProgress) {
    return new Promise((resolve, reject) => {
      const es = new EventSource(`/api/docs/${id}/events`);
      es.onmessage = (m) => {
        const ev = JSON.parse(m.data);
        if (ev.stage === 'extract') onProgress(0.1 + (ev.total ? ev.done / ev.total : 0) * 0.8, ev.message);
        else if (ev.stage === 'structure') onProgress(0.9 + (ev.done / ev.total) * 0.1, ev.message);
        else if (ev.stage === 'done') { es.close(); resolve(); }
        else if (ev.stage === 'error') { es.close(); reject(new Error(ev.message)); }
      };
      es.onerror = () => { es.close(); reject(new Error('진행 상황을 받지 못했습니다. 잠시 뒤 [최근 분석한 약관 열기]에서 다시 열어 주십시오.')); };
    });
  }

  async function open(id, onProgress = () => {}) {
    let res = await fetch(`/api/docs/${id}`);
    if (res.status === 409) {
      // 앱의 약관 읽기 규칙이 바뀌어 서버가 다시 분석하는 중입니다.
      onProgress(0.05, '앱의 약관 읽기 규칙이 개선되어 이 약관을 다시 분석합니다. 직접 고친 내용은 그대로 옮겨 둡니다.');
      await followStructure(id, onProgress);
      res = await fetch(`/api/docs/${id}`);
    }
    if (!res.ok) throw new Error('분석 결과를 열지 못했습니다.');
    return res.json();
  }

  async function pageText(id, n) {
    const res = await fetch(`/api/docs/${id}/pages/${n}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || '그 쪽을 읽지 못했습니다.');
    return body;
  }

  async function save(id, review) {
    const res = await fetch(`/api/docs/${id}/review`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(review) });
    return res.ok;
  }

  // ───────────── 2단계: 담보 분석·코드마스터 ─────────────
  async function json(res) {
    let body = {};
    try { body = await res.json(); } catch { /* 빈 응답 */ }
    if (!res.ok) throw new Error(body.error || `요청이 실패했습니다(${res.status}).`);
    return body;
  }
  const config = async () => json(await fetch('/api/config'));
  const results = async (id) => json(await fetch(`/api/docs/${id}/analysis`));
  const runAnalysis = async (id, coverageIds, force) => json(await fetch(`/api/docs/${id}/analysis`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ coverageIds, force }) }));
  const stopAnalysis = async (id) => json(await fetch(`/api/docs/${id}/analysis/stop`, { method: 'POST' }));
  // 진행 상황을 받다가 끝나면 닫습니다. onEvent(ev)
  function watchAnalysis(id, onEvent) {
    const es = new EventSource(`/api/docs/${id}/analysis/events`);
    es.onmessage = (m) => { const ev = JSON.parse(m.data); onEvent(ev); if (ev.stage === 'done' || ev.stage === 'idle') es.close(); };
    es.onerror = () => { es.close(); onEvent({ stage: 'done', message: '진행 상황 연결이 끊겼습니다. 결과를 다시 불러옵니다.' }); };
    return () => es.close();
  }
  async function uploadMaster(file) {
    return json(await fetch('/api/codemaster', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file }));
  }
  const resetMaster = async () => json(await fetch('/api/codemaster', { method: 'DELETE' }));

  window.CoverageApi = {
    analyze, list, open, save, pageText,
    supportsAnalysis: true, config, results, runAnalysis, stopAnalysis, watchAnalysis, uploadMaster, resetMaster, masterDownloadUrl: '/api/codemaster/download',
    sampleUrl: 'samples/sample_policy.pdf',
    storageNote: '올린 PDF와 분석 결과는 이 PC의 data 폴더에만 저장됩니다. 같은 PDF를 다시 올리면 저장된 결과를 바로 엽니다.',
    savedLabel: '이 PC에 저장됨',
  };
})();
