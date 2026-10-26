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
export function planMove(order, parents, { ids, targetId = null, position, collapsed = new Set() }) {
  const tree = buildTree(order, parents);
  const { parentOf } = tree;
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
  const targetKids = targetId === null ? [] : tree.children.get(targetId);
  switch (position) {
    case 'inside':
      newParent = targetId;
      index = targetKids.length;
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
