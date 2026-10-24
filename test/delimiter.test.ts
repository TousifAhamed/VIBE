import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countFields, detectDelimiter } from '../src/engine/delimiter';

test('countFields ignores delimiters inside quotes', () => {
  assert.equal(countFields('a,"b,c",d', ','), 3);
  assert.equal(countFields('a,"he said ""hi, there""",d', ','), 3);
});

test('detects common delimiters', () => {
  assert.equal(detectDelimiter('a,b,c\n1,2,3\n4,5,6\n'), ',');
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3\n4\t5\t6\n'), '\t');
  assert.equal(detectDelimiter('a|b|c\n1|2|3\n4|5|6\n'), '|');
  assert.equal(detectDelimiter('a;b;c\n1;2,5;3\n4;5,1;6\n'), ';');
});

test('prefers consistent splits over frequent characters', () => {
  const sample = 'name;note\nAnn;likes a, b and c\nBo;none\nCy;x, y\n';
  assert.equal(detectDelimiter(sample), ';');
});

test('falls back to space only when nothing else splits', () => {
  assert.equal(detectDelimiter('x y z\n1 2 3\n4 5 6\n'), ' ');
  assert.equal(detectDelimiter('just one column\nof free text, really\n'), ',');
});

test('handles an empty sample', () => {
  assert.equal(detectDelimiter(''), ',');
});
