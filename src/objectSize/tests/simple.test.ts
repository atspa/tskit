import objectSize from "../index.ts";

const data = {
    title: "Example",
    items: [1, 2, 3],
};

console.log(objectSize(data));
// 0 — defaults to MB with precision 2

console.log(objectSize(data, { unit: "b" }));
// 35

console.log(
    objectSize(data, {
        unit: "kb",
        precision: 4,
    }),
);
// 0.0342