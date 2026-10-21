import assert from "node:assert/strict";
import test from "node:test";
import { matchBcFilter, rowMatchesFilters } from "../src/bc-filter.js";

test("exact, joker, bereik, vergelijking en OF", () => {
  assert.equal(matchBcFilter("London", "london"), true);
  assert.equal(matchBcFilter("Twist BV", "*twist*"), true);
  assert.equal(matchBcFilter("Twist BV", "T?ist*"), true);
  assert.equal(matchBcFilter("Adatum", "*twist*"), false);
  assert.equal(matchBcFilter("15000", "10000..20000"), true);
  assert.equal(matchBcFilter("20000", "10000..20000"), true);
  assert.equal(matchBcFilter("9999", "10000..20000"), false);
  assert.equal(matchBcFilter("50", "..100"), true);
  assert.equal(matchBcFilter("150", "100.."), true);
  assert.equal(matchBcFilter("1001", ">1000"), true);
  assert.equal(matchBcFilter("1000", ">=1000"), true);
  assert.equal(matchBcFilter("999", "<1000"), true);
  assert.equal(matchBcFilter("1000", "<=1000"), true);
  assert.equal(matchBcFilter("3", "<>3"), false);
  assert.equal(matchBcFilter("1234,5", ">1234"), true);
  assert.equal(matchBcFilter("M", "A..M"), true);
  assert.equal(matchBcFilter("Alpha", "A|Beta|alpha"), true);
  assert.equal(matchBcFilter("Beta", "@beta"), true);
  assert.equal(matchBcFilter("a.b", "a.b"), true);
  assert.equal(matchBcFilter("", "''"), true);
});

test("filters zijn EN en de kolom is hoofdletterongevoelig", () => {
  const row = { Naam: "Twist", "Nr.": "10" };
  assert.equal(rowMatchesFilters(row, [
    { column: "naam", value: "*twist*" },
    { column: "Nr.", value: ">=10" },
  ]), true);
  assert.equal(rowMatchesFilters(row, [
    { column: "naam", value: "*twist*" },
    { column: "Nr.", value: "<10" },
  ]), false);
  assert.equal(rowMatchesFilters(row, [{ column: "Stad", value: "A" }]), false);
});
