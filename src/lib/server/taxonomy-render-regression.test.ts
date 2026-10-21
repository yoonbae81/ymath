import { expect, it } from 'vitest';
import { parseTaxonomy, renderTaxonomy } from './taxonomy-core';

it('renders copyable canonical unit names without appending course metadata', () => {
 const taxonomy = parseTaxonomy('## 기하\n### 삼각형과 사각형의 성질 | 중2-2\n- GEO-TRIANGLE | 삼각형의 성질\n');
 const prompt = renderTaxonomy(taxonomy);
 expect(prompt.split('\n').filter(line => line.startsWith('### 단원: ')))
  .toEqual(['### 단원: 삼각형과 사각형의 성질']);
 expect(prompt).toContain('교육과정: 중2-2');
 expect(prompt).toContain('unit_major에는 단원명만');
});
