import { Select } from "@cloudflare/kumo";
import { useCallback } from "react";

import type { BlockInteraction, SelectElement } from "../types.js";

const DEFAULT_PLACEHOLDER = "Select...";

export function SelectElementComponent({
	element,
	onAction,
	onChange,
}: {
	element: SelectElement;
	onAction: (interaction: BlockInteraction) => void;
	onChange?: (actionId: string, value: unknown) => void;
}) {
	const handleValueChange = useCallback(
		(value: unknown) => {
			if (onChange) {
				onChange(element.action_id, value);
			} else {
				onAction({
					type: "block_action",
					action_id: element.action_id,
					value,
				});
			}
		},
		[onChange, onAction, element.action_id],
	);

	// An empty-string value counts as "no value" to the underlying Select, which
	// then shows the placeholder. An option declaring `value: ""` *is* that empty
	// state, so its label is the placeholder text unless the element sets one.
	const placeholder =
		element.placeholder ??
		element.options.find((opt) => opt.value === "")?.label ??
		DEFAULT_PLACEHOLDER;

	// `items` is what the trigger resolves its label from; without it the trigger
	// renders the raw selected value. The children still render the popup.
	return (
		<Select
			label={element.label}
			items={element.options}
			placeholder={placeholder}
			defaultValue={element.initial_value}
			onValueChange={handleValueChange}
		>
			{element.options.map((opt) => (
				<Select.Option key={opt.value} value={opt.value}>
					{opt.label}
				</Select.Option>
			))}
		</Select>
	);
}
