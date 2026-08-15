/**
 * EditorLayoutManager — Manages Editor_Group layouts (0–6 groups).
 *
 * Requirements: 2.1, 2.2, 2.7
 *
 * Layout policy:
 * - Supports zero through six simultaneous Editor_Groups
 * - Rejects a seventh group accessibly without mutating layout
 * - For zero groups: clears layout state, renders no panes
 * - For four groups: uses a two-by-two grid layout
 * - For five/six groups: switches away from two-by-two to a supported layout
 * - All arrangements are keyboard-operable
 * - Layout transitions go directly to the target count without intermediate layouts
 */

/**
 * Supported arrangement types for Editor_Group layouts.
 */
export type ArrangementType =
  | 'none'           // Zero groups
  | 'single'         // One group
  | 'horizontal'     // Two or three groups side by side
  | 'vertical'       // Two or three groups stacked
  | 'two-by-two'     // Exactly four groups in a 2x2 grid
  | 'two-by-three'   // Five or six groups: 2 rows x 3 cols
  | 'three-by-two';  // Five or six groups: 3 rows x 2 cols

/**
 * Represents a layout slot assignment for a group.
 */
export interface LayoutSlot {
  groupId: string;
  row: number;
  column: number;
  rowSpan: number;
  colSpan: number;
}

/**
 * Result of a layout transition attempt.
 */
export interface LayoutTransitionResult {
  success: boolean;
  /** Accessible message explaining rejection if success is false. */
  rejectionReason?: string;
  previousCount?: number;
  newCount?: number;
  arrangement?: ArrangementType;
}

/**
 * Current layout state snapshot.
 */
export interface LayoutState {
  groupCount: number;
  arrangement: ArrangementType;
  slots: LayoutSlot[];
}

/** Maximum supported Editor_Group count. */
export const MAX_GROUPS = 6;

/** Minimum supported Editor_Group count. */
export const MIN_GROUPS = 0;

/**
 * Resolves the default arrangement for a given group count.
 */
export function getDefaultArrangement(count: number): ArrangementType {
  switch (count) {
    case 0: return 'none';
    case 1: return 'single';
    case 2: return 'horizontal';
    case 3: return 'horizontal';
    case 4: return 'two-by-two';
    case 5: return 'two-by-three';
    case 6: return 'two-by-three';
    default: return 'none';
  }
}

/**
 * Returns valid arrangement types for a given group count.
 */
export function getValidArrangements(count: number): ArrangementType[] {
  switch (count) {
    case 0: return ['none'];
    case 1: return ['single'];
    case 2: return ['horizontal', 'vertical'];
    case 3: return ['horizontal', 'vertical'];
    case 4: return ['two-by-two'];
    case 5: return ['two-by-three', 'three-by-two'];
    case 6: return ['two-by-three', 'three-by-two'];
    default: return [];
  }
}

/**
 * Computes layout slots for a given arrangement and group IDs.
 */
export function computeSlots(arrangement: ArrangementType, groupIds: string[]): LayoutSlot[] {
  const count = groupIds.length;

  switch (arrangement) {
    case 'none':
      return [];

    case 'single':
      return [{ groupId: groupIds[0]!, row: 0, column: 0, rowSpan: 1, colSpan: 1 }];

    case 'horizontal':
      return groupIds.map((id, i) => ({
        groupId: id,
        row: 0,
        column: i,
        rowSpan: 1,
        colSpan: 1,
      }));

    case 'vertical':
      return groupIds.map((id, i) => ({
        groupId: id,
        row: i,
        column: 0,
        rowSpan: 1,
        colSpan: 1,
      }));

    case 'two-by-two':
      return groupIds.slice(0, 4).map((id, i) => ({
        groupId: id,
        row: Math.floor(i / 2),
        column: i % 2,
        rowSpan: 1,
        colSpan: 1,
      }));

    case 'two-by-three':
      // 2 rows x 3 columns. For 5 groups, last slot of row 2 is empty.
      return groupIds.slice(0, 6).map((id, i) => ({
        groupId: id,
        row: Math.floor(i / 3),
        column: i % 3,
        rowSpan: 1,
        colSpan: 1,
      }));

    case 'three-by-two':
      // 3 rows x 2 columns. For 5 groups, last slot of row 3 is empty.
      return groupIds.slice(0, 6).map((id, i) => ({
        groupId: id,
        row: Math.floor(i / 2),
        column: i % 2,
        rowSpan: 1,
        colSpan: 1,
      }));

    default:
      return [];
  }
}

/**
 * EditorLayoutManager tracks current group count, arrangement, and layout slots.
 * Validates layout transitions and assigns layout slots based on count and arrangement.
 */
export class EditorLayoutManager {
  private _groupCount: number = 0;
  private _arrangement: ArrangementType = 'none';
  private _groupIds: string[] = [];
  private _slots: LayoutSlot[] = [];

  /** Current number of groups. */
  get groupCount(): number {
    return this._groupCount;
  }

  /** Current arrangement type. */
  get arrangement(): ArrangementType {
    return this._arrangement;
  }

  /** Current layout slots. */
  get slots(): ReadonlyArray<LayoutSlot> {
    return this._slots;
  }

  /** Current group IDs in layout order. */
  get groupIds(): ReadonlyArray<string> {
    return this._groupIds;
  }

  /**
   * Get a full snapshot of the current layout state.
   */
  getState(): LayoutState {
    return {
      groupCount: this._groupCount,
      arrangement: this._arrangement,
      slots: [...this._slots],
    };
  }

  /**
   * Attempt to set the layout to a specific group count.
   * Rejects counts > MAX_GROUPS without mutation.
   */
  setGroupCount(groupIds: string[]): LayoutTransitionResult {
    const count = groupIds.length;

    if (count > MAX_GROUPS) {
      return {
        success: false,
        rejectionReason:
          `Cannot display ${count} Editor_Groups. The maximum supported count is ${MAX_GROUPS}. ` +
          `Please close an existing group before opening a new one.`,
        previousCount: this._groupCount,
      };
    }

    if (count < MIN_GROUPS) {
      return {
        success: false,
        rejectionReason: `Invalid group count: ${count}. Minimum is ${MIN_GROUPS}.`,
        previousCount: this._groupCount,
      };
    }

    const previousCount = this._groupCount;
    const arrangement = this._resolveArrangement(count);

    // Transition directly to target — no intermediate layouts
    this._groupCount = count;
    this._arrangement = arrangement;
    this._groupIds = [...groupIds];
    this._slots = computeSlots(arrangement, this._groupIds);

    return {
      success: true,
      previousCount,
      newCount: count,
      arrangement,
    };
  }

  /**
   * Attempt to add a group. Returns a transition result.
   */
  addGroup(groupId: string): LayoutTransitionResult {
    const newIds = [...this._groupIds, groupId];
    return this.setGroupCount(newIds);
  }

  /**
   * Remove a group by ID. Returns a transition result.
   */
  removeGroup(groupId: string): LayoutTransitionResult {
    const newIds = this._groupIds.filter((id) => id !== groupId);
    if (newIds.length === this._groupIds.length) {
      return {
        success: false,
        rejectionReason: `Group "${groupId}" not found in layout.`,
        previousCount: this._groupCount,
      };
    }
    return this.setGroupCount(newIds);
  }

  /**
   * Change the arrangement type for the current group count.
   * Falls back to a valid arrangement if the requested one is unsupported.
   */
  setArrangement(arrangement: ArrangementType): LayoutTransitionResult {
    const validArrangements = getValidArrangements(this._groupCount);

    if (validArrangements.includes(arrangement)) {
      this._arrangement = arrangement;
      this._slots = computeSlots(arrangement, this._groupIds);
      return {
        success: true,
        previousCount: this._groupCount,
        newCount: this._groupCount,
        arrangement,
      };
    }

    // Fallback: use any valid arrangement for the current count
    if (validArrangements.length > 0) {
      const fallback = validArrangements[0]!;
      this._arrangement = fallback;
      this._slots = computeSlots(fallback, this._groupIds);
      return {
        success: true,
        previousCount: this._groupCount,
        newCount: this._groupCount,
        arrangement: fallback,
      };
    }

    return {
      success: false,
      rejectionReason: `No valid arrangement available for ${this._groupCount} groups.`,
      previousCount: this._groupCount,
    };
  }

  /**
   * Clear layout state completely (set to zero groups).
   */
  clear(): void {
    this._groupCount = 0;
    this._arrangement = 'none';
    this._groupIds = [];
    this._slots = [];
  }

  /**
   * Resolve the arrangement for a given count, considering the current arrangement.
   * - For 0: always 'none'
   * - For 4: always 'two-by-two'
   * - For 5 or 6: switch away from 'two-by-two' to a supported layout
   * - For 2 or 3: prefer current if valid, otherwise default
   */
  private _resolveArrangement(count: number): ArrangementType {
    if (count === 0) return 'none';
    if (count === 1) return 'single';
    if (count === 4) return 'two-by-two';

    const valid = getValidArrangements(count);

    // For 5 or 6, two-by-two is never valid (enforced by getValidArrangements)
    // If the current arrangement is valid for the new count, preserve it
    if (valid.includes(this._arrangement)) {
      return this._arrangement;
    }

    // Otherwise use the default
    return getDefaultArrangement(count);
  }
}
