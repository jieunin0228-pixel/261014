// 로컬 파일 저장소. 모든 데이터는 프로젝트의 data/ 폴더 안에만 둡니다(외부 서버·DB 없음).
//   data/files/<해시>.pdf        업로드한 원본
//   data/cache/<해시>/*.json     분석 결과(같은 PDF 를 다시 올리면 재사용)
//   data/reviews/<해시>.json     사용자 수정·검토 상태(재분석해도 지워지지 않음)
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const dirs = { files: path.join(DATA_DIR, 'files'), cache: path.join(DATA_DIR, 'cache'), reviews: path.join(DATA_DIR, 'reviews'), codemaster: path.join(DATA_DIR, 'codemaster'), tmp: path.join(DATA_DIR, 'tmp') };
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

const ID = /^[a-f0-9]{64}$/;
function checkId(id) {
  if (!ID.test(id)) throw Object.assign(new Error('잘못된 문서 ID입니다.'), { status: 400 });
  return id;
}

const pdfPath = (id) => path.join(dirs.files, `${checkId(id)}.pdf`);
const cacheDir = (id) => path.join(dirs.cache, checkId(id));
const cachePath = (id, name) => path.join(cacheDir(id), `${name}.json`);

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
// 쓰는 도중 꺼져도 파일이 깨지지 않도록 임시 파일에 쓴 뒤 이름을 바꿉니다.
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

const readCache = (id, name) => readJson(cachePath(id, name));
const writeCache = (id, name, value) => writeJson(cachePath(id, name), value);
const readReview = (id) => readJson(path.join(dirs.reviews, `${checkId(id)}.json`), {});
const writeReview = (id, value) => writeJson(path.join(dirs.reviews, `${checkId(id)}.json`), { ...value, savedAt: new Date().toISOString() });

// 담보별 분석 결과: data/cache/<해시>/analysis/<담보ID>.json
const safeKey = (k) => String(k).replace(/[^A-Za-z0-9_-]/g, '_');
const analysisPath = (id, coverageId) => path.join(cacheDir(id), 'analysis', `${safeKey(coverageId)}.json`);
const readAnalysis = (id, coverageId) => readJson(analysisPath(id, coverageId));
const writeAnalysis = (id, coverageId, value) => writeJson(analysisPath(id, coverageId), value);
function listAnalyses(id) {
  const dir = path.join(cacheDir(id), 'analysis');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f))).filter(Boolean);
}

// 코드마스터: 올린 것이 있으면 그것, 없으면 임시 코드마스터
const masterFile = path.join(dirs.codemaster, 'current.json');
const readMaster = () => readJson(masterFile);
const writeMaster = (m) => writeJson(masterFile, m);
const clearMaster = () => fs.rmSync(masterFile, { force: true });

function listDocs() {
  return fs.readdirSync(dirs.cache)
    .filter((id) => ID.test(id))
    .map((id) => readCache(id, 'meta'))
    .filter(Boolean)
    .sort((a, b) => String(b.openedAt || b.createdAt).localeCompare(String(a.openedAt || a.createdAt)));
}

module.exports = { DATA_DIR, dirs, checkId, pdfPath, cacheDir, readCache, writeCache, readReview, writeReview, listDocs, readAnalysis, writeAnalysis, listAnalyses, readMaster, writeMaster, clearMaster };
