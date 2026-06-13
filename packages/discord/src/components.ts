const MESSAGE_ROW_KEYS = new Set(['type', 'components']);
const BUTTON_KEYS = new Set(['type', 'customId', 'label', 'style', 'disabled']);
const MODAL_LABEL_KEYS = new Set(['type', 'label', 'description', 'component']);
const TEXT_INPUT_KEYS = new Set([
	'type',
	'customId',
	'style',
	'placeholder',
	'required',
	'minLength',
	'maxLength',
]);

export function normalizeMessageComponents(value: unknown): readonly unknown[] | undefined {
	if (!Array.isArray(value) || value.length < 1 || value.length > 5) return undefined;
	const rows: unknown[] = [];
	for (const row of value) {
		if (
			!isRecord(row) ||
			!hasOnlyKeys(row, MESSAGE_ROW_KEYS) ||
			row.type !== 1 ||
			!Array.isArray(row.components) ||
			row.components.length < 1 ||
			row.components.length > 5
		) {
			return undefined;
		}
		const buttons: unknown[] = [];
		for (const button of row.components) {
			if (
				!isRecord(button) ||
				!hasOnlyKeys(button, BUTTON_KEYS) ||
				button.type !== 2 ||
				!isBoundedInteger(button.style, 1, 4) ||
				!isBoundedString(button.customId, 1, 100) ||
				!isBoundedString(button.label, 1, 80) ||
				(button.disabled !== undefined && typeof button.disabled !== 'boolean')
			) {
				return undefined;
			}
			buttons.push({
				type: 2,
				style: button.style,
				custom_id: button.customId,
				label: button.label,
				...(button.disabled === undefined ? {} : { disabled: button.disabled }),
			});
		}
		rows.push({ type: 1, components: buttons });
	}
	return rows;
}

export function normalizeModalComponents(value: unknown): readonly unknown[] | undefined {
	if (!Array.isArray(value) || value.length < 1 || value.length > 5) return undefined;
	const labels: unknown[] = [];
	for (const label of value) {
		if (
			!isRecord(label) ||
			!hasOnlyKeys(label, MODAL_LABEL_KEYS) ||
			label.type !== 18 ||
			!isBoundedString(label.label, 1, 45) ||
			(label.description !== undefined && !isBoundedString(label.description, 1, 100)) ||
			!isRecord(label.component)
		) {
			return undefined;
		}
		const input = label.component;
		if (
			!hasOnlyKeys(input, TEXT_INPUT_KEYS) ||
			input.type !== 4 ||
			!isBoundedString(input.customId, 1, 100) ||
			(input.style !== 1 && input.style !== 2) ||
			(input.placeholder !== undefined && !isBoundedString(input.placeholder, 1, 100)) ||
			(input.required !== undefined && typeof input.required !== 'boolean')
		) {
			return undefined;
		}
		const minLength = optionalBoundedInteger(input.minLength, 0, 4_000);
		const maxLength = optionalBoundedInteger(input.maxLength, 1, 4_000);
		if (input.minLength !== undefined && minLength === undefined) return undefined;
		if (input.maxLength !== undefined && maxLength === undefined) return undefined;
		if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
			return undefined;
		}
		labels.push({
			type: 18,
			label: label.label,
			...(label.description === undefined ? {} : { description: label.description }),
			component: {
				type: 4,
				custom_id: input.customId,
				style: input.style,
				...(input.placeholder === undefined ? {} : { placeholder: input.placeholder }),
				...(input.required === undefined ? {} : { required: input.required }),
				...(minLength === undefined ? {} : { min_length: minLength }),
				...(maxLength === undefined ? {} : { max_length: maxLength }),
			},
		});
	}
	return labels;
}

function optionalBoundedInteger(
	value: unknown,
	minimum: number,
	maximum: number,
): number | undefined {
	return isBoundedInteger(value, minimum, maximum) ? value : undefined;
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
	return (
		typeof value === 'number' &&
		Number.isSafeInteger(value) &&
		value >= minimum &&
		value <= maximum
	);
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
	return typeof value === 'string' && value.length >= minimum && value.length <= maximum;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => keys.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
