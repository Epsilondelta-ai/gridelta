// Flue 대화 저장소 (Flue 규약 파일). 없으면 메모리 DB 라 재시작 시 대화가 사라진다.
// 앱 DB(gridelta.db)와 파일을 나눈다.
import { join } from 'node:path';
import { sqlite } from '@flue/runtime/node';
import { config } from './config.ts';

export default sqlite(join(config.dataDir, 'flue.db'));
