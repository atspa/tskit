// objectSize.ts

export type ObjectSizeUnit = "b" | "kb" | "mb" | "gb" | "tb";

export interface ObjectSizeOptions {
    unit?: ObjectSizeUnit;
    precision?: number;
}

const BYTES_PER_UNIT: Record<ObjectSizeUnit, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
    tb: 1024 ** 4,
};

/**
 * Calculates the UTF-8 byte size of an object's minified JSON representation.
 *
 * @param object - JSON-serializable value to measure.
 * @param init - Output unit and decimal precision.
 * @returns Size in the requested unit.
 *
 * @throws {TypeError} If the value cannot be serialized to JSON.
 * @throws {RangeError} If precision is invalid.
 */
export function objectSize(
    object: unknown,
    init: ObjectSizeOptions = {},
): number {
    const {
        unit = "mb",
        precision = 2,
    } = init;

    if (!Number.isInteger(precision) || precision < 0 || precision > 100) {
        throw new RangeError(
            `precision must be an integer between 0 and 100; received ${precision}`,
        );
    }

    const json = JSON.stringify(object);

    if (json === undefined) {
        throw new TypeError(
            "The provided value cannot be represented as JSON.",
        );
    }

    const bytes = new TextEncoder().encode(json).byteLength;
    const size = bytes / BYTES_PER_UNIT[unit];

    return Number(size.toFixed(precision));
}

export default objectSize;