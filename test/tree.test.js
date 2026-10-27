import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ancestorsOf,
  buildTree,
  descendantsOf,
  flatten,
  inferParent,
  joinSplits,
  planMove,
  planMoves,
  releaseChildren,
  sanitize,
  splitPairs,
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

// --- Split views ----------------------------------------------------------------

// H and P form a split view: P is H's first child (see joinSplits).
const split = outline(`
A
H
 P
 X
 Y
B
`);
const partners = new Set(['P']);

test('splitPairs pairs tabs that share a split view', () => {
  const splits = { H: 7, P: 7, Q: 9 };
  assert.deepEqual(splitPairs(['A', 'H', 'P', 'Q', 'B'], (id) => splits[id] ?? null), [['H', 'P']]);
  // Even with a tab briefly between them.
  assert.deepEqual(splitPairs(['H', 'X', 'P'], (id) => splits[id] ?? null), [['H', 'P']]);
});

test('joinSplits makes the partner the head\'s first child, with no children', () => {
  // P was made a sibling with a child of its own, and H a child of... nothing.
  const { order, parents } = outline(`
H
P
 Z
`);
  for (const [id, parent] of joinSplits(parents, [['H', 'P']])) parents.set(id, parent);
  assert.equal(draw(order, parents), ['H', ' P', ' Z'].join('\n'));

  // The head had been nested under its own partner.
  const nested = new Map([['H', 'P'], ['P', 'A'], ['A', null]]);
  for (const [id, parent] of joinSplits(nested, [['H', 'P']])) nested.set(id, parent);
  assert.deepEqual([...nested], [['H', 'A'], ['P', 'H'], ['A', null]]);
});

test('planMove never puts a tab between a split view\'s halves', () => {
  for (const position of ['firstChild', 'after']) {
    const plan = planMove(split.order, split.parents, { ids: ['B'], targetId: 'H', position, partners });
    assert.deepEqual(plan.order, ['A', 'H', 'P', 'B', 'X', 'Y'], position);
    assert.equal(plan.parents.get('B'), 'H');
  }
});

test('planMove treats a split view as one item', () => {
  // Moving or targeting the partner means the whole item.
  let plan = planMove(split.order, split.parents, { ids: ['P'], position: 'end', partners });
  assert.deepEqual(plan.order, ['A', 'B', 'H', 'P', 'X', 'Y']);
  plan = planMove(split.order, split.parents, { ids: ['A'], targetId: 'P', position: 'inside', partners });
  assert.equal(plan.parents.get('A'), 'H');
  // Only the partner as a child: dropping after the item makes a sibling.
  const lone = outline(`
H
 P
B
`);
  plan = planMove(lone.order, lone.parents, { ids: ['B'], targetId: 'H', position: 'after', partners });
  assert.equal(plan.parents.get('B'), null);
});

test('planMoves reorders around split view tabs without moving them', () => {
  const check = (current, target) => {
    const { moves, keptFixed } = planMoves(current, target, new Set(['H', 'P']));
    assert.equal(keptFixed, true);
    assert.ok(!moves.some((m) => m.id === 'H' || m.id === 'P'), JSON.stringify(moves));
    const order = current.slice();
    for (const { id, index } of moves) {
      order.splice(order.indexOf(id), 1);
      order.splice(index, 0, id);
    }
    assert.deepEqual(order, target);
    // No step may put a tab between H and P.
    const steps = current.slice();
    for (const { id, index } of moves) {
      steps.splice(steps.indexOf(id), 1);
      steps.splice(index, 0, id);
      assert.equal(steps[steps.indexOf('H') + 1], 'P', `after moving ${id}: ${steps}`);
    }
  };
  check(['X', 'H', 'P'], ['H', 'P', 'X']);
  check(['A', 'H', 'P', 'B', 'C'], ['H', 'P', 'A', 'C', 'B']);
  check(['H', 'P', 'A', 'B'], ['A', 'B', 'H', 'P']);
  check(['A', 'B', 'C', 'H', 'P'], ['C', 'H', 'P', 'B', 'A']);
});

test('planMoves moves split view tabs only when their order changes', () => {
  const { moves, keptFixed } = planMoves(['H', 'P', 'K', 'Q'], ['K', 'Q', 'H', 'P'], new Set(['H', 'P', 'K', 'Q']));
  assert.equal(keptFixed, false);
  assert.ok(moves.length > 0);
});
