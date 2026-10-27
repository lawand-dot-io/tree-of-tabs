// Pure tree helpers shared by the background worker and the side panel.
//
// A window's tree is described by two things:
//   order   - ids of the window's unpinned tabs, in native tab strip order
//   parents - Map<tabId, parentId | null>
//
// Sibling order is never stored: it is derived from the native order. The
// background keeps every subtree contiguous in the tab strip, directly after
// its root, so the strip and the tree always agree.

/**
 * Builds children lists from `order` and `parents`. Parents that are missing
 * from `order`, or that would form a cycle, are ignored (the tab becomes a
 * root), so the result is always a proper forest.
 */
export function buildTree(order, parents) {
  const present = new Set(order);
  const parentOf = new Map();
  const children = new Map();
  const roots = [];
  for (const id of order) children.set(id, []);
  for (const id of order) {
    let p = parents.get(id) ?? null;
    if (p !== null && (!present.has(p) || createsCycle(id, p, parents))) p = null;
    parentOf.set(id, p);
    if (p === null) roots.push(id);
    else children.get(p).push(id);
  }
  return { roots, children, parentOf };
}

function createsCycle(id, start, parents) {
  const seen = new Set([id]);
  for (let c = start; c !== null && c !== undefined; c = parents.get(c) ?? null) {
    if (seen.has(c)) return true;
    seen.add(c);
  }
  return false;
}

/** Depth-first order of a tree built by buildTree(). */
export function flatten(tree) {
  const out = [];
  const visit = (id) => {
    out.push(id);
    for (const child of tree.children.get(id)) visit(child);
  };
  tree.roots.forEach(visit);
  return out;
}

/** All descendants of `id`, depth first. */
export function descendantsOf(tree, id) {
  const out = [];
  const visit = (x) => {
    for (const child of tree.children.get(x) ?? []) {
      out.push(child);
      visit(child);
    }
  };
  visit(id);
  return out;
}

/** Ancestors of `id`, nearest first. */
export function ancestorsOf(parents, id) {
  const out = [];
  const seen = new Set([id]);
  for (let p = parents.get(id) ?? null; p !== null && !seen.has(p); p = parents.get(p) ?? null) {
    out.push(p);
    seen.add(p);
  }
  return out;
}

/**
 * Returns corrected parents for a window whose native order may no longer
 * match the tree: a tab whose parent is not one of the tabs directly above it
 * in the same branch becomes a root. Ids missing from `parents` (tabs the
 * background has not processed yet) are skipped entirely.
 */
export function sanitize(order, parents) {
  const result = new Map();
  const stack = [];
  for (const id of order) {
    if (!parents.has(id)) continue;
    const p = parents.get(id) ?? null;
    const at = p === null ? -1 : stack.lastIndexOf(p);
    stack.length = at + 1;
    result.set(id, at === -1 ? null : p);
    stack.push(id);
  }
  return result;
}

/**
 * Guesses the parent of a tab from where it sits in the native order, the
 * way a tab dropped into the tab strip should behave: it becomes a sibling of
 * the tab right below it (ignoring its own descendants, which may have been
 * left behind by a native drag). With nothing below it, it becomes a root.
 */
export function inferParent(order, parents, id) {
  const tree = buildTree(order, parents);
  const own = new Set(descendantsOf(tree, id));
  const pos = order.indexOf(id);
  for (let i = pos + 1; i < order.length; i++) {
    const next = order[i];
    if (own.has(next) || !parents.has(next)) continue;
    const p = tree.parentOf.get(next);
    return p === id || own.has(p) ? null : p;
  }
  return null;
}

/**
 * Plans moving `ids` (each with its whole subtree) relative to `targetId`.
 * `partners` are the second tabs of split views (see joinSplits).
 *
 * Positions:
 *   before     - sibling right before the target
 *   after      - right after the target; when the target is expanded and has
 *                children this means "first child", like dropping between a
 *                parent and its first child
 *   afterTree  - sibling after the target's whole subtree
 *   inside     - last child of the target
 *   firstChild - first child of the target
 *   end        - last root (targetId is ignored)
 *
 * Returns { order, parents } describing the whole window afterwards, or null
 * when the move is impossible (dropping a tree into itself).
 */
export function planMove(order, parents, { ids, targetId = null, position, collapsed = new Set(), partners = new Set() }) {
  const tree = buildTree(order, parents);
  const { parentOf } = tree;
  // A split view moves, and is dropped onto, as one item: its head.
  const itemOf = (id) => (partners.has(id) ? parentOf.get(id) ?? id : id);
  ids = ids.map(itemOf);
  if (targetId !== null) targetId = itemOf(targetId);
  const moving = new Set(ids.filter((id) => tree.children.has(id)));
  if (!moving.size) return null;

  const underMoving = (id) => {
    for (let c = id; c !== null; c = parentOf.get(c) ?? null) if (moving.has(c)) return true;
    return false;
  };
  if (targetId !== null && !tree.children.has(targetId)) position = 'end';
  if (position !== 'end' && underMoving(targetId)) return null;

  // Only the topmost selected tabs move explicitly; the rest ride along.
  const tops = flatten(tree).filter((id) => moving.has(id) && !underMoving(parentOf.get(id)));
  const siblingsOf = (p) => (p === null ? tree.roots : tree.children.get(p));
  for (const id of tops) {
    const list = siblingsOf(parentOf.get(id));
    list.splice(list.indexOf(id), 1);
  }

  let newParent;
  let index;
  // A split view's partner isn't a child the user sees, so it doesn't count.
  const ownKids = (id) => (tree.children.get(id) ?? []).filter((kid) => !partners.has(kid));
  const targetKids = targetId === null ? [] : ownKids(targetId);
  switch (position) {
    case 'inside':
      newParent = targetId;
      index = tree.children.get(targetId).length;
      break;
    case 'firstChild':
      newParent = targetId;
      index = 0;
      break;
    case 'after':
      if (targetKids.length && !collapsed.has(targetId)) {
        newParent = targetId;
        index = 0;
        break;
      }
    // falls through
    case 'afterTree':
    case 'before': {
      newParent = parentOf.get(targetId);
      const list = siblingsOf(newParent);
      index = list.indexOf(targetId) + (position === 'before' ? 0 : 1);
      break;
    }
    default:
      newParent = null;
      index = tree.roots.length;
  }

  // Nothing goes between a split view's head and its partner.
  if (index === 0 && partners.has(siblingsOf(newParent)[0])) index = 1;
  siblingsOf(newParent).splice(index, 0, ...tops);
  for (const id of tops) parentOf.set(id, newParent);
  return { order: flatten(tree), parents: new Map(order.map((id) => [id, parentOf.get(id)])) };
}

/**
 * Decides what happens to the children of a tab that leaves the tree (closed,
 * pinned or moved to another window). Returns the parent changes to apply.
 *
 *   promoteFirst - the first child takes the tab's place, its siblings
 *                  become its children (Tree Style Tab's default)
 *   promoteAll   - all children move up one level
 */
export function releaseChildren(order, parents, id, mode) {
  const changes = new Map();
  const kids = order.filter((x) => x !== id && parents.get(x) === id);
  if (!kids.length) return changes;
  const grandParent = parents.get(id) ?? null;
  if (mode === 'promoteAll') {
    for (const kid of kids) changes.set(kid, grandParent);
  } else {
    changes.set(kids[0], grandParent);
    for (const kid of kids.slice(1)) changes.set(kid, kids[0]);
  }
  return changes;
}

// --- Split views ----------------------------------------------------------------
// Chrome can show two tabs of a window side by side, as a split view. It keeps
// them next to each other in the tab strip, and ends the split when an
// extension moves either of them or puts another tab between them. So the
// tree treats a split view as one item: the second tab (the partner) is the
// first child of the first one (the head), has no children of its own, and
// nothing is placed between them.

/**
 * The split views in `order`, as [head, partner] pairs in tab order. Tabs
 * pair up by their split view id, even when something briefly sits between
 * them (a tab Chrome just opened there, which the worker then moves out).
 */
export function splitPairs(order, splitOf) {
  const firsts = new Map();
  const pairs = [];
  for (const id of order) {
    const split = splitOf(id);
    if (split === null) continue;
    if (!firsts.has(split)) firsts.set(split, id);
    else if (firsts.get(split) !== null) pairs.push([firsts.get(split), id]), firsts.set(split, null);
  }
  return pairs;
}

/** Parent changes that make each split view one item (see above). */
export function joinSplits(parents, pairs) {
  const changes = new Map();
  const parentOf = (id) => (changes.has(id) ? changes.get(id) : parents.get(id) ?? null);
  for (const [head, partner] of pairs) {
    let parent = parentOf(head);
    if (parent === partner) parent = parentOf(partner) === head ? null : parentOf(partner);
    if (parentOf(head) !== parent) changes.set(head, parent);
    if (parentOf(partner) !== head) changes.set(partner, head);
    // The partner's children become the item's children.
    for (const id of new Set([...parents.keys(), ...changes.keys()])) {
      if (id !== head && parentOf(id) === partner) changes.set(id, head);
    }
  }
  return changes;
}

/**
 * Plans single-tab moves that turn the order `current` into `target`, each
 * as { id, index } with the index the tab ends up at. Tabs in `fixed` (those
 * in split views) are never moved: the tabs around them move instead. That
 * works as long as the fixed tabs keep their order among themselves; when
 * they can't, they move too and `keptFixed` is false.
 */
export function planMoves(current, target, fixed = new Set()) {
  const order = current.slice();
  const moves = [];
  const fixedNow = order.filter((id) => fixed.has(id));
  const fixedThen = target.filter((id) => fixed.has(id));
  const keptFixed = fixedNow.length === fixedThen.length && fixedNow.every((id, i) => id === fixedThen[i]);
  const move = (id, index) => {
    order.splice(order.indexOf(id), 1);
    order.splice(index, 0, id);
    moves.push({ id, index });
  };
  for (let i = 0; i < target.length; i++) {
    while (order[i] !== target[i]) {
      if (!keptFixed || !fixed.has(target[i])) {
        move(target[i], i);
        break;
      }
      // A fixed tab belongs here: move the tab in its way past it, and past
      // any fixed tabs right after it, so it never lands inside a split view.
      let after = order.indexOf(target[i]);
      while (fixed.has(order[after + 1])) after++;
      move(order[i], after);
    }
  }
  return { moves, keptFixed };
}
