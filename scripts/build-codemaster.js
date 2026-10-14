// 임시 코드마스터 엑셀(codemaster/임시_코드마스터.xlsx)을 만듭니다. 실제 코드마스터를 받으면 이 파일을 고쳐 앱에 올립니다.
// 실행: node scripts/build-codemaster.js
const fs = require('fs');
const path = require('path');
const { provisionalMaster, toXlsx } = require('../server/ecs/codemaster');

(async () => {
  const dir = path.join(__dirname, '..', 'codemaster');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '임시_코드마스터.xlsx'), Buffer.from(await toXlsx(provisionalMaster())));
  console.log('codemaster/임시_코드마스터.xlsx 생성');
})();
