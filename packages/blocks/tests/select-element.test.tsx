import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SelectElementComponent } from "../src/elements/select.js";
import type { SelectElement } from "../src/types.js";

// Deliberately not mocking @cloudflare/kumo: the trigger label and the empty
// state come out of the real Select, so a mock would assert nothing.

afterEach(cleanup);

const OPTIONS = [
	{ label: "Published", value: "pub_1" },
	{ label: "Draft", value: "dft_2" },
];

function renderSelect(element: Partial<SelectElement>) {
	const onAction = vi.fn();
	const onChange = vi.fn();
	render(
		<SelectElementComponent
			element={{
				type: "select",
				action_id: "status",
				label: "Status",
				options: OPTIONS,
				...element,
			}}
			onAction={onAction}
			onChange={onChange}
		/>,
	);
	return { onAction, onChange };
}

function trigger() {
	return screen.getByRole("combobox");
}

/** Base UI only commits a click that follows a pointer press on the option. */
function pick(name: string) {
	fireEvent.click(trigger());
	const option = screen.getByRole("option", { name });
	fireEvent.pointerDown(option);
	fireEvent.click(option);
}

describe("select element", () => {
	it("renders the label of the selected option, not its value", () => {
		renderSelect({ initial_value: "pub_1" });

		expect(trigger().textContent).toContain("Published");
		expect(trigger().textContent).not.toContain("pub_1");
	});

	it("renders the label of the option picked by the user", () => {
		renderSelect({ initial_value: "pub_1" });

		pick("Draft");

		expect(trigger().textContent).toContain("Draft");
		expect(trigger().textContent).not.toContain("dft_2");
	});

	it("renders a placeholder when nothing is selected", () => {
		renderSelect({ placeholder: "Any status" });

		expect(trigger().textContent).toContain("Any status");
	});

	it("renders a default placeholder when the element has none", () => {
		renderSelect({});

		expect(trigger().textContent).toContain("Select...");
	});

	it("renders the label of an empty-value option as the empty state", () => {
		renderSelect({
			options: [{ label: "All statuses", value: "" }, ...OPTIONS],
			initial_value: "",
		});

		expect(trigger().textContent).toContain("All statuses");
	});

	it("prefers an explicit placeholder over an empty-value option's label", () => {
		renderSelect({
			options: [{ label: "All statuses", value: "" }, ...OPTIONS],
			initial_value: "",
			placeholder: "Filter by status",
		});

		expect(trigger().textContent).toContain("Filter by status");
	});

	it("submits the option value unchanged", () => {
		const { onChange } = renderSelect({ initial_value: "pub_1" });

		pick("Draft");

		expect(onChange).toHaveBeenCalledWith("status", "dft_2");
	});

	it("submits an empty-string option value unchanged", () => {
		const { onChange } = renderSelect({
			options: [{ label: "All statuses", value: "" }, ...OPTIONS],
			initial_value: "pub_1",
		});

		pick("All statuses");

		expect(onChange).toHaveBeenCalledWith("status", "");
	});

	it("reports the value through onAction when no onChange is given", () => {
		const onAction = vi.fn();
		render(
			<SelectElementComponent
				element={{
					type: "select",
					action_id: "status",
					label: "Status",
					options: OPTIONS,
				}}
				onAction={onAction}
			/>,
		);

		pick("Draft");

		expect(onAction).toHaveBeenCalledWith({
			type: "block_action",
			action_id: "status",
			value: "dft_2",
		});
	});
});
