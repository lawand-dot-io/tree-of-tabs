import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ancestorsOf,
  buildTree,
  descendantsOf,
  flatten,
  inferParent,
  planMove,
  releaseChildren,
  sanitize,
} from '../src/tree.js';

// Builds { order, parents } from an indented outline such as
//   A
//    B
//    C
//   D
// where each leading space is one level and names become ids.
function outline(text) {
  const order = [];
  const parents = new Map();
  const stack = [];
  for (const line of text.split('\n').filter((l) => l.trim())) {
    const depth = line.length - line.trimStart().length;
    const id = line.trim();
    stack.length = depth;
    parents.set(id, depth ? stack[depth - 1] : null);
    stack.push(id);
    order.push(id);
  }
  return { order, parents };
}

// Renders a tree back to an outline for readable assertions.
function draw(order, parents) {
  const tree = buildTree(order, parents);
  const lines = [];
  const visit = (id, depth) => {
    lines.push(' '.repeat(depth) + id);
    tree.children.get(id).forEach((c) => visit(c, depth + 1));
  };
  tree.roots.forEach((id) => visit(id, 0));
  return lines.join('\n');
}

const fixture = outline(`
A
 B
  C
 D
E
F
 G
`);

test('buildTree and flatten round-trip a valid tree', () => {
  const tree = buildTree(fixture.order, fixture.parents);
  assert.deepEqual(tree.roots, ['A', 'E', 'F']);
  assert.deepEqual(tree.children.get('A'), ['B', 'D']);
  assert.deepEqual(flatten(tree), fixture.order);
});

test('buildTree treats missing parents and cycles as roots', () => {
  const parents = new Map([
    ['A', 'Z'],
    ['B', 'C'],
    ['C', 'B'],
  ]);
  const tree = buildTree(['A', 'B', 'C'], parents);
  assert.deepEqual(tree.roots, ['A', 'B', 'C']);
});

test('descendantsOf and ancestorsOf', () => {
  const tree = buildTree(fixture.order, fixture.parents);
  assert.deepEqual(descendantsOf(tree, 'A'), ['B', 'C', 'D']);
  assert.deepEqual(ancestorsOf(fixture.parents, 'C'), ['B', 'A']);
});

test('sanitize keeps a valid tree and repairs a broken one', () => {
  assert.deepEqual(sanitize(fixture.order, fixture.parents), fixture.parents);
  // E moved between B and C natively: C can no longer be a child of B.
  const order = ['A', 'B', 'E', 'C', 'D', 'F', 'G'];
  const fixed = sanitize(order, fixture.parents);
  assert.equal(fixed.get('C'), null);
  assert.equal(fixed.get('D'), null);
  assert.equal(fixed.get('G'), 'F');
});

test('sanitize skips tabs it does not know yet', () => {
  const order = ['A', 'B', 'NEW', 'C', 'D', 'E', 'F', 'G'];
  const fixed = sanitize(order, fixture.parents);
  assert.equal(fixed.has('NEW'), false);
  assert.equal(fixed.get('C'), 'B');
});

test('inferParent makes a tab a sibling of the tab below it', () => {
  const parents = new Map(fixture.parents);
  // X dropped between B and C natively: sibling of C, so a child of B.
  const order = ['A', 'B', 'X', 'C', 'D', 'E', 'F', 'G'];
  parents.set('X', null);
  assert.equal(inferParent(order, parents, 'X'), 'B');
  // Dropped at the very end: root.
  assert.equal(inferParent([...fixture.order, 'X'], parents, 'X'), null);
});

test('inferParent ignores descendants left behind by a native drag', () => {
  // A dragged after E in the tab strip; its children stay where they were.
  const order = ['B', 'C', 'D', 'E', 'A', 'F', 'G'];
  assert.equal(inferParent(order, fixture.parents, 'A'), null);
  const relaid = flatten(buildTree(order, fixture.parents));
  assert.deepEqual(relaid, ['E', 'A', 'B', 'C', 'D', 'F', 'G']);
});

test('planMove inside makes the tree the last child of the target', () => {
  const plan = planMove(fixture.order, fixture.parents, { ids: ['A'], targetId: 'G', position: 'inside' });
  assert.equal(
    draw(plan.order, plan.parents),
    ['E', 'F', ' G', '  A', '   B', '    C', '   D'].join('\n'),
  );
  assert.deepEqual(plan.order, ['E', 'F', 'G', 'A', 'B', 'C', 'D']);
});

test('planMove before and after place siblings', () => {
  let plan = planMove(fixture.order, fixture.parents, { ids: ['G'], targetId: 'B', position: 'before' });
  assert.equal(plan.parents.get('G'), 'A');
  assert.deepEqual(plan.order, ['A', 'G', 'B', 'C', 'D', 'E', 'F']);

  plan = planMove(fixture.order, fixture.parents, { ids: ['E'], targetId: 'C', position: 'after' });
  assert.equal(plan.parents.get('E'), 'B');
  assert.deepEqual(plan.order, ['A', 'B', 'C', 'E', 'D', 'F', 'G']);
});

test('planMove after an expanded parent means first child', () => {
  const plan = planMove(fixture.order, fixture.parents, { ids: ['E'], targetId: 'A', position: 'after' });
  assert.equal(plan.parents.get('E'), 'A');
  assert.deepEqual(plan.order, ['A', 'E', 'B', 'C', 'D', 'F', 'G']);
});

test('planMove after a collapsed parent goes after its whole tree', () => {
  const plan = planMove(fixture.order, fixture.parents, {
    ids: ['G'],
    targetId: 'A',
    position: 'after',
    collapsed: new Set(['A']),
  });
  assert.equal(plan.parents.get('G'), null);
  assert.deepEqual(plan.order, ['A', 'B', 'C', 'D', 'G', 'E', 'F']);
});

test('planMove end and afterTree', () => {
  let plan = planMove(fixture.order, fixture.parents, { ids: ['B'], position: 'end' });
  assert.equal(plan.parents.get('B'), null);
  assert.deepEqual(plan.order, ['A', 'D', 'E', 'F', 'G', 'B', 'C']);

  plan = planMove(fixture.order, fixture.parents, { ids: ['C'], targetId: 'B', position: 'afterTree' });
  assert.equal(plan.parents.get('C'), 'A');
  assert.deepEqual(plan.order, ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
});

test('planMove refuses to drop a tree into itself', () => {
  assert.equal(planMove(fixture.order, fixture.parents, { ids: ['A'], targetId: 'C', position: 'inside' }), null);
  assert.equal(planMove(fixture.order, fixture.parents, { ids: ['A'], targetId: 'A', position: 'inside' }), null);
});

test('planMove moves several trees, keeping their order', () => {
  const plan = planMove(fixture.order, fixture.parents, {
    ids: ['E', 'B', 'C'], // C rides along with B.
    targetId: 'G',
    position: 'inside',
  });
  assert.equal(draw(plan.order, plan.parents), ['A', ' D', 'F', ' G', '  B', '   C', '  E'].join('\n'));
});

test('planMove with an unknown target appends at the end', () => {
  const plan = planMove(fixture.order, fixture.parents, { ids: ['B'], targetId: 'nope', position: 'inside' });
  assert.equal(plan.parents.get('B'), null);
  assert.equal(plan.order.at(-2), 'B');
});

test('releaseChildren promotes the first child by default', () => {
  const order = fixture.order.filter((id) => id !== 'A');
  const changes = releaseChildren(order, fixture.parents, 'A', 'promoteFirst');
  assert.deepEqual([...changes], [
    ['B', null],
    ['D', 'B'],
  ]);
  const parents = new Map(fixture.parents);
  for (const [id, p] of changes) parents.set(id, p);
  parents.delete('A');
  // The tab strip order needs no change after promotion.
  assert.deepEqual(flatten(buildTree(order, parents)), order);
});

test('releaseChildren can move all children up a level', () => {
  const order = fixture.order.filter((id) => id !== 'B');
  const changes = releaseChildren(order, fixture.parents, 'B', 'promoteAll');
  assert.deepEqual([...changes], [['C', 'A']]);
});
