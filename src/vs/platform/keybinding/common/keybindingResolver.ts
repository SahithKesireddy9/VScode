/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as arrays from 'vs/base/common/arrays';
import { KeyboundCommand } from 'vs/base/common/keybindings';
import { ContextKeyExprType, ContextKeyExpression, IContext, IContextKeyService, expressionsAreEqualWithConstantSubstitution, implies } from 'vs/platform/contextkey/common/contextkey';
import { ResolvedKeybindingItem } from 'vs/platform/keybinding/common/resolvedKeybindingItem';

export interface IResolveResult {
	/** Whether the resolved keybinding is entering a multi chord */
	enterMultiChord: boolean;
	/** Whether the resolved keybinding is leaving (and executing) a multi chord keybinding */
	leaveMultiChord: boolean;
	commands: KeyboundCommand[];
	bubble: boolean;
}

export class KeybindingResolver {
	private readonly _log: (str: string) => void;
	private readonly _defaultKeybindings: ResolvedKeybindingItem[];
	private readonly _keybindings: ResolvedKeybindingItem[];
	private readonly _defaultBoundCommands: Map</* commandId */ string, boolean>;
	private readonly _map: Map</* 1st chord's keypress */ string, ResolvedKeybindingItem[]>;
	/** contains only single-command keybindings (ie doesn't contain no-command and multi-command keybindings).
	 * for multi-command case: we don't want to associate a command with a keybinding,
	 * e.g., we don't want to show it as a hint in command palette or context menu because that keybinding will trigger other commands as well
	 */
	private readonly _lookupMap: Map</* commandId */ string, ResolvedKeybindingItem[]>;

	constructor(
		/** built-in and extension-provided keybindings */
		defaultKeybindings: ResolvedKeybindingItem[],
		/** user's keybindings */
		overrides: ResolvedKeybindingItem[],
		log: (str: string) => void
	) {
		this._log = log;
		this._defaultKeybindings = defaultKeybindings;

		this._defaultBoundCommands = new Map<string, boolean>();
		for (const defaultKeybinding of defaultKeybindings) {
			for (const { command } of defaultKeybinding.commands) { // `defaultKeybinding.commands.length` must be 1 - search for "// TODO@ulugbekna: non-user-defined multi-command keybindings"
				if (command && command.charAt(0) !== '-') {
					this._defaultBoundCommands.set(command, true);
				}
			}
		}

		this._map = new Map<string, ResolvedKeybindingItem[]>();
		this._lookupMap = new Map<string, ResolvedKeybindingItem[]>();

		this._keybindings = KeybindingResolver.handleRemovals(([] as ResolvedKeybindingItem[]).concat(defaultKeybindings).concat(overrides));
		for (let i = 0, len = this._keybindings.length; i < len; i++) {
			const k = this._keybindings[i];
			if (k.chords.length === 0) {
				// unbound
				continue;
			}

			if (k.when && k.when.type === ContextKeyExprType.False) {
				// when condition is false
				continue;
			}

			// TODO@chords
			this._addKeyPress(k.chords[0], k);
		}
	}

	private static _isTargetedForRemoval(defaultKb: ResolvedKeybindingItem, keypressFirstPart: string | null, keypressChordPart: string | null, when: ContextKeyExpression | undefined): boolean {
		// TODO@chords
		if (keypressFirstPart && defaultKb.chords[0] !== keypressFirstPart) {
			return false;
		}
		// TODO@chords
		if (keypressChordPart && defaultKb.chords[1] !== keypressChordPart) {
			return false;
		}

		// `true` means always, as does `undefined`
		// so we will treat `true` === `undefined`
		if (when && when.type !== ContextKeyExprType.True) {
			if (!defaultKb.when) {
				return false;
			}
			if (!expressionsAreEqualWithConstantSubstitution(when, defaultKb.when)) {
				return false;
			}
		}
		return true;

	}

	/**
	 * Looks for rules containing "-commandId" and removes them.
	 */
	public static handleRemovals(rules: ResolvedKeybindingItem[]): ResolvedKeybindingItem[] {
		// Do a first pass and construct a hash-map for removals
		const removals = new Map</* commandId */ string, ResolvedKeybindingItem[]>();
		for (let i = 0, len = rules.length; i < len; i++) {
			const rule = rules[i];
			if (rule.commands.length === 1 && rule.commands[0].command.charAt(0) === '-') { // no removals for multi-command keybindings
				const command = rule.commands[0].command.substring(1);
				if (!removals.has(command)) {
					removals.set(command, [rule]);
				} else {
					removals.get(command)!.push(rule);
				}
			}
		}

		if (removals.size === 0) {
			// There are no removals
			return rules;
		}

		// Do a second pass and keep only non-removed keybindings
		const result: ResolvedKeybindingItem[] = [];
		for (let i = 0, len = rules.length; i < len; i++) {
			const rule = rules[i];

			if (rule.commands.length === 0 || rule.commands.length > 1 || rule.commands[0].command.length === 0) {
				result.push(rule); // FIXME@ulugbekna: why do we push when there's no bound command?
				continue;
			}
			if (rule.commands[0].command.charAt(0) === '-') {
				continue;
			}
			const commandRemovals = removals.get(rule.commands[0].command);
			if (!commandRemovals || !rule.isDefault) {
				result.push(rule);
				continue;
			}
			let isRemoved = false;
			for (const commandRemoval of commandRemovals) {
				// TODO@chords
				const keypressFirstChord = commandRemoval.chords[0];
				const keypressSecondChord = commandRemoval.chords[1];
				const when = commandRemoval.when;
				if (this._isTargetedForRemoval(rule, keypressFirstChord, keypressSecondChord, when)) {
					isRemoved = true;
					break;
				}
			}
			if (!isRemoved) {
				result.push(rule);
				continue;
			}
		}
		return result;
	}

	private _addKeyPress(keypress: string, item: ResolvedKeybindingItem): void {

		const conflicts = this._map.get(keypress);

		if (typeof conflicts === 'undefined') {
			// There is no conflict so far
			this._map.set(keypress, [item]);
			this._addToLookupMap(item);
			return;
		}

		for (let i = conflicts.length - 1; i >= 0; i--) {
			const conflict = conflicts[i];

			if (arrays.equals(conflict.commands, item.commands, (a, b) => a.command === b.command)) { // TODO@ulugebkna: we don't compare command args, but should we?
				continue;
			}

			const conflictHasMultipleChords = (conflict.chords.length > 1);
			const itemHasMultipleChords = (item.chords.length > 1);

			// TODO@chords
			if (conflictHasMultipleChords && itemHasMultipleChords && conflict.chords[1] !== item.chords[1]) {
				// The conflict only shares the first chord with this command
				continue;
			}

			if (KeybindingResolver.whenIsEntirelyIncluded(conflict.when, item.when)) {
				// `item` completely overwrites `conflict`
				// Remove conflict from the lookupMap
				this._removeFromLookupMap(conflict);
			}
		}

		conflicts.push(item);
		this._addToLookupMap(item);
	}

	private _addToLookupMap(item: ResolvedKeybindingItem): void {
		// ignore no-command and multi-command keybindings - we don't want to show keybinding hints for multi-command keybindings
		if (item.commands.length !== 1) {
			return;
		}
		const command = item.commands[0].command;
		let arr = this._lookupMap.get(command);
		if (typeof arr === 'undefined') {
			arr = [item];
			this._lookupMap.set(command, arr);
		} else {
			arr.push(item);
		}
	}

	private _removeFromLookupMap(item: ResolvedKeybindingItem): void {
		// ignore no-command and multi-command keybindings - we don't want to show keybinding hints for multi-command keybindings
		if (item.commands.length !== 1) {
			return;
		}

		for (const { command } of item.commands) {
			const arr = this._lookupMap.get(command);
			if (typeof arr === 'undefined') {
				return;
			}
			for (let i = 0, len = arr.length; i < len; i++) {
				if (arr[i] === item) {
					arr.splice(i, 1);
					return;
				}
			}
		}
	}

	/**
	 * Returns true if it is provable `a` implies `b`.
	 */
	public static whenIsEntirelyIncluded(a: ContextKeyExpression | null | undefined, b: ContextKeyExpression | null | undefined): boolean {
		if (!b || b.type === ContextKeyExprType.True) {
			return true;
		}
		if (!a || a.type === ContextKeyExprType.True) {
			return false;
		}

		return implies(a, b);
	}

	public getDefaultBoundCommands(): Map<string, boolean> {
		return this._defaultBoundCommands;
	}

	public getDefaultKeybindings(): readonly ResolvedKeybindingItem[] {
		return this._defaultKeybindings;
	}

	public getKeybindings(): readonly ResolvedKeybindingItem[] {
		return this._keybindings;
	}

	public lookupKeybindings(commandId: string): ResolvedKeybindingItem[] {
		const items = this._lookupMap.get(commandId);
		if (typeof items === 'undefined' || items.length === 0) {
			return [];
		}

		// Reverse to get the most specific item first
		const result: ResolvedKeybindingItem[] = [];
		let resultLen = 0;
		for (let i = items.length - 1; i >= 0; i--) {
			result[resultLen++] = items[i];
		}
		return result;
	}

	public lookupPrimaryKeybinding(commandId: string, context: IContextKeyService): ResolvedKeybindingItem | null {
		const items = this._lookupMap.get(commandId);
		if (typeof items === 'undefined' || items.length === 0) {
			return null;
		}
		if (items.length === 1) {
			return items[0];
		}

		for (let i = items.length - 1; i >= 0; i--) {
			const item = items[i];
			if (context.contextMatchesRules(item.when)) {
				return item;
			}
		}

		return items[items.length - 1];
	}

	public resolve(context: IContext, currentChord: string | null, keypress: string): IResolveResult | null {
		this._log(`| Resolving ${keypress}${currentChord ? ` chorded from ${currentChord}` : ``}`);
		let lookupMap: ResolvedKeybindingItem[] | null = null;

		if (currentChord !== null) {
			// Fetch all chord bindings for `currentChord`

			const candidates = this._map.get(currentChord);
			if (typeof candidates === 'undefined') {
				// No chords starting with `currentChord`
				this._log(`\\ No keybinding entries.`);
				return null;
			}

			lookupMap = [];
			for (let i = 0, len = candidates.length; i < len; i++) {
				const candidate = candidates[i];
				// TODO@chords
				if (candidate.chords[1] === keypress) {
					lookupMap.push(candidate);
				}
			}
		} else {
			const candidates = this._map.get(keypress);
			if (typeof candidates === 'undefined') {
				// No bindings with `keypress`
				this._log(`\\ No keybinding entries.`);
				return null;
			}

			lookupMap = candidates;
		}

		const result = this._findCommand(context, lookupMap);
		if (!result) {
			this._log(`\\ From ${lookupMap.length} keybinding entries, no when clauses matched the context.`);
			return null;
		}

		// TODO@chords
		if (currentChord === null && result.chords.length > 1 && result.chords[1] !== null) {
			this._log(`\\ From ${lookupMap.length} keybinding entries, matched chord, when: ${printWhenExplanation(result.when)}, source: ${printSourceExplanation(result)}.`);
			return {
				enterMultiChord: true,
				leaveMultiChord: false,
				commands: [],
				bubble: false
			};
		}

		this._log(`\\ From ${lookupMap.length} keybinding entries, matched ${JSON.stringify(result.commands)}, when: ${printWhenExplanation(result.when)}, source: ${printSourceExplanation(result)}.`);
		return {
			enterMultiChord: false,
			leaveMultiChord: result.chords.length > 1,
			commands: result.commands,
			bubble: result.bubble
		};
	}

	private _findCommand(context: IContext, matches: ResolvedKeybindingItem[]): ResolvedKeybindingItem | null {
		for (let i = matches.length - 1; i >= 0; i--) {
			const k = matches[i];

			if (!KeybindingResolver._contextMatchesRules(context, k.when)) {
				continue;
			}

			return k;
		}

		return null;
	}

	private static _contextMatchesRules(context: IContext, rules: ContextKeyExpression | null | undefined): boolean {
		if (!rules) {
			return true;
		}
		return rules.evaluate(context);
	}
}

function printWhenExplanation(when: ContextKeyExpression | undefined): string {
	if (!when) {
		return `no when condition`;
	}
	return `${when.serialize()}`;
}

function printSourceExplanation(kb: ResolvedKeybindingItem): string {
	return (
		kb.extensionId
			? (kb.isBuiltinExtension ? `built-in extension ${kb.extensionId}` : `user extension ${kb.extensionId}`)
			: (kb.isDefault ? `built-in` : `user`)
	);
}
