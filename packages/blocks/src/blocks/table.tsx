import { Badge, Button } from "@cloudflare/kumo";
import { ArrowDown, ArrowUp } from "@phosphor-icons/react";
import { useState } from "react";

import type { BlockInteraction, TableBlock, TableColumn, TableRowAction } from "../types.js";
import { cn, formatRelativeTime } from "../utils.js";

const DEFAULT_ROW_ACTION_LABEL = "Open";

/**
 * A row click must not steal activation from a control inside a cell, and must
 * not fire twice when the row's own activation button is what was clicked.
 */
const INTERACTIVE_DESCENDANTS = "a, button, input, select, textarea, summary, [role='button']";

function rowActionValue(row: Record<string, unknown>, rowAction: TableRowAction): unknown {
	return rowAction.value_key === undefined ? row : row[rowAction.value_key];
}

function isRowActivatable(row: Record<string, unknown>, rowAction: TableRowAction): boolean {
	return rowAction.value_key === undefined || row[rowAction.value_key] != null;
}

/**
 * Appends the leading cell's text to the label so a screen reader announces one
 * row's control apart from the next.
 */
function rowActionLabel(
	rowAction: TableRowAction,
	row: Record<string, unknown>,
	columns: TableColumn[],
): string {
	const label = rowAction.label ?? DEFAULT_ROW_ACTION_LABEL;
	const key = columns[0]?.key;
	const name = key === undefined ? undefined : row[key];
	if (typeof name === "number") return `${label} ${name}`;
	if (typeof name === "string" && name.trim() !== "") return `${label} ${name}`;
	return label;
}

function formatCell(value: unknown, format: TableColumn["format"]): React.ReactNode {
	let str: string;
	if (value == null) {
		str = "";
	} else if (typeof value === "string") {
		str = value;
	} else if (typeof value === "number" || typeof value === "boolean") {
		str = String(value);
	} else if (typeof value === "object") {
		str = JSON.stringify(value);
	} else {
		str = "";
	}
	switch (format) {
		case "badge":
			return <Badge>{str}</Badge>;
		case "relative_time":
			return str ? formatRelativeTime(str) : "";
		case "number": {
			const num = Number(value);
			return Number.isNaN(num) ? str : num.toLocaleString();
		}
		case "code":
			return <code className="rounded bg-kumo-tint px-1.5 py-0.5 font-mono text-sm">{str}</code>;
		default:
			return str;
	}
}

export function TableBlockComponent({
	block,
	onAction,
}: {
	block: TableBlock;
	onAction: (interaction: BlockInteraction) => void;
}) {
	const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);

	function handleSort(key: string) {
		const next =
			sort?.key === key && sort.dir === "asc"
				? { key, dir: "desc" as const }
				: { key, dir: "asc" as const };
		setSort(next);
		onAction({
			type: "block_action",
			action_id: block.page_action_id,
			block_id: block.block_id,
			value: { sort: next },
		});
	}

	function handleLoadMore() {
		onAction({
			type: "block_action",
			action_id: block.page_action_id,
			block_id: block.block_id,
			value: { cursor: block.next_cursor, sort },
		});
	}

	const rowAction = block.row_action;

	function handleRowAction(row: Record<string, unknown>) {
		if (!rowAction) return;
		onAction({
			type: "block_action",
			action_id: rowAction.action_id,
			block_id: block.block_id,
			value: rowActionValue(row, rowAction),
		});
	}

	function handleRowClick(
		event: React.MouseEvent<HTMLTableRowElement>,
		row: Record<string, unknown>,
	) {
		const target = event.target;
		if (target instanceof Element && target.closest(INTERACTIVE_DESCENDANTS)) return;
		handleRowAction(row);
	}

	if (block.rows.length === 0 && block.empty_text) {
		return <p className="py-4 text-center text-sm text-kumo-subtle">{block.empty_text}</p>;
	}

	return (
		<div className="overflow-x-auto">
			<table className="w-full text-start text-sm">
				<thead>
					<tr className="border-b border-kumo-line">
						{block.columns.map((col) => (
							<th
								key={col.key}
								scope="col"
								className={cn(
									"px-3 py-2 text-sm font-medium text-kumo-subtle",
									col.sortable && "cursor-pointer select-none",
								)}
								onClick={col.sortable ? () => handleSort(col.key) : undefined}
							>
								<span className="inline-flex items-center gap-1">
									{col.label}
									{col.sortable &&
										sort?.key === col.key &&
										(sort.dir === "asc" ? <ArrowUp size={14} /> : <ArrowDown size={14} />)}
								</span>
							</th>
						))}
						{rowAction && (
							<th scope="col" className="px-3 py-2">
								<span className="sr-only">{rowAction.label ?? DEFAULT_ROW_ACTION_LABEL}</span>
							</th>
						)}
					</tr>
				</thead>
				<tbody>
					{block.rows.map((row, i) => {
						const activatable = rowAction !== undefined && isRowActivatable(row, rowAction);
						return (
							<tr
								key={i}
								className={cn(
									"border-b border-kumo-line last:border-0",
									activatable &&
										"cursor-pointer hover:bg-kumo-tint/25 focus-within:bg-kumo-tint/25",
								)}
								onClick={activatable ? (event) => handleRowClick(event, row) : undefined}
							>
								{block.columns.map((col) => (
									<td key={col.key} className="px-3 py-2 text-kumo-default">
										{formatCell(row[col.key], col.format)}
									</td>
								))}
								{rowAction && (
									<td className="px-3 py-2 text-end">
										{activatable && (
											<Button
												variant="ghost"
												size="sm"
												aria-label={rowActionLabel(rowAction, row, block.columns)}
												onClick={() => handleRowAction(row)}
											>
												{rowAction.label ?? DEFAULT_ROW_ACTION_LABEL}
											</Button>
										)}
									</td>
								)}
							</tr>
						);
					})}
				</tbody>
			</table>
			{block.next_cursor && (
				<div className="mt-2 flex justify-center">
					<button
						type="button"
						onClick={handleLoadMore}
						className="text-sm text-kumo-link hover:underline"
					>
						Load more
					</button>
				</div>
			)}
		</div>
	);
}
