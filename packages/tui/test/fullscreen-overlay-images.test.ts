import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	deleteAllKittyPlacements,
	encodeKitty,
	getKittyImagePlacement,
	registerKittyImageMetadata,
	resetCapabilitiesCache,
	setCapabilities,
} from "../src/terminal-image.ts";
import type { Component } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class RecordingTerminal extends VirtualTerminal {
	writes: string[] = [];

	override write(data: string) {
		this.writes.push(data);
		super.write(data);
	}

	takeOutput() {
		return this.writes.splice(0).join("");
	}
}

function imageLine(imageId: number) {
	registerKittyImageMetadata({ imageId, columns: 2, rows: 3, widthPx: 100, heightPx: 100 });
	return encodeKitty("AAAA", { columns: 2, rows: 3, imageId, moveCursor: false });
}

async function fixture() {
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	const terminal = new RecordingTerminal(80, 18);
	const tui = new TuiAltScreen(terminal);
	const images = [imageLine(69951), imageLine(69952)];
	const document = [images[0], "", "", images[1], "", "", ...Array.from({ length: 25 }, (_, i) => `chat ${i}`)];
	tui.addChild({ render: () => document, invalidate() {} });
	tui.start();
	tui.renderNow();
	tui.scrollToTop();
	tui.renderNow();
	await terminal.flush();
	assert.ok(terminal.takeOutput().includes("i=69951"));
	return { terminal, tui, images, document };
}

function fullPage(terminal: RecordingTerminal, label: string): Component {
	return {
		render: () => Array.from({ length: terminal.rows }, (_, i) => `${label} ${i}`),
		invalidate() {},
	};
}

function assertRestored(output: string, images: string[]) {
	for (const image of images) {
		const placement = getKittyImagePlacement(image);
		assert.ok(placement);
		assert.ok(output.includes(placement.sequence), "restore the cached image placement without re-uploading it");
	}
	assert.doesNotMatch(output, /\x1b_Ga=T,/);
}

// Regression coverage for #6995 / #9439. VirtualTerminal verifies text cells;
// recorded Kitty commands verify placement ownership, not real terminal pixels.
describe("fullscreen overlays over Kitty images", () => {
	afterEach(() => resetCapabilitiesCache());

	it("hides both placements through refresh and resize, then restores them on repeated closes", async () => {
		const { terminal, tui, images, document } = await fixture();
		const before = [...document];
		try {
			for (let cycle = 0; cycle < 3; cycle++) {
				const overlay = tui.showOverlay(fullPage(terminal, "dashboard"), {
					anchor: "top-left",
					width: "100%",
					maxHeight: "100%",
				});
				tui.renderNow();
				const entered = terminal.takeOutput();
				assert.ok(entered.includes(deleteAllKittyPlacements()));
				assert.doesNotMatch(entered, /\x1b_Ga=[Tp],/);
				await terminal.flush();
				assert.ok(terminal.getViewport().every((line) => line.startsWith("dashboard")));
				for (const [columns, rows] of [
					[44, 14],
					[100, 24],
					[80, 18],
				]) {
					terminal.resize(columns, rows);
					tui.renderNow();
					assert.doesNotMatch(terminal.takeOutput(), /\x1b_Ga=[Tp],/);
					await terminal.flush();
					assert.ok(terminal.getViewport().every((line) => line.startsWith("dashboard")));
				}
				tui.renderNow();
				assert.doesNotMatch(
					terminal.takeOutput(),
					/\x1b_G|\x1b\[2J|dashboard/,
					"an unchanged overlay does not redraw or delete images again",
				);
				overlay.hide();
				tui.renderNow();
				assertRestored(terminal.takeOutput(), images);
				assert.deepEqual(document, before);
				assert.equal(tui.hasOverlay(), false);
				tui.scrollBy(2);
				tui.renderNow();
				tui.scrollToTop();
				tui.renderNow();
				terminal.takeOutput();
			}
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});

	it("preserves images for partial width or actual height, even with full-screen sizing options", async () => {
		const { terminal, tui } = await fixture();
		try {
			for (const width of ["50%", "100%"] as const) {
				const overlay = tui.showOverlay(
					{ render: () => ["partial"], invalidate() {} },
					{
						anchor: "top-left",
						width,
						maxHeight: "100%",
					},
				);
				tui.renderNow();
				assert.equal(terminal.takeOutput().includes(deleteAllKittyPlacements()), false);
				overlay.hide();
				tui.renderNow();
				terminal.takeOutput();
			}
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});

	it("restores images only when the last covering overlay closes", async () => {
		const { terminal, tui, images } = await fixture();
		try {
			const lower = tui.showOverlay(fullPage(terminal, "lower"), { anchor: "top-left", width: "100%" });
			tui.renderNow();
			terminal.takeOutput();
			const upper = tui.showOverlay(fullPage(terminal, "upper"), { anchor: "top-left", width: "100%" });
			tui.renderNow();
			terminal.takeOutput();
			upper.hide();
			tui.renderNow();
			const lowerAgain = terminal.takeOutput();
			assert.doesNotMatch(lowerAgain, /\x1b_Ga=[Tp],/);
			await terminal.flush();
			assert.ok(terminal.getViewport().every((line) => line.startsWith("lower")));
			lower.hide();
			tui.renderNow();
			assertRestored(terminal.takeOutput(), images);
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});

	it("keeps the overlay's own image and restores its underlying images", async () => {
		const { terminal, tui, images } = await fixture();
		const ownImage = imageLine(69953);
		try {
			const overlay = tui.showOverlay(
				{
					render: () => [ownImage, ...Array(terminal.rows - 1).fill("overlay")],
					invalidate() {},
				},
				{ anchor: "top-left", width: "100%" },
			);
			tui.renderNow();
			const entered = terminal.takeOutput();
			assert.ok(entered.includes("i=69953"));
			assert.equal(entered.includes("i=69951"), false);
			assert.equal(entered.includes("i=69952"), false);
			overlay.hide();
			tui.renderNow();
			const restored = terminal.takeOutput();
			assertRestored(restored, images);
			assert.equal(restored.includes("i=69953"), false);
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});

	it("restores and reclaims placements when a covering overlay becomes hidden or visible", async () => {
		const { terminal, tui, images } = await fixture();
		try {
			const overlay = tui.showOverlay(fullPage(terminal, "dashboard"), { anchor: "top-left", width: "100%" });
			tui.renderNow();
			terminal.takeOutput();
			overlay.setHidden(true);
			tui.renderNow();
			assertRestored(terminal.takeOutput(), images);
			overlay.setHidden(false);
			tui.renderNow();
			const visibleAgain = terminal.takeOutput();
			assert.ok(visibleAgain.includes(deleteAllKittyPlacements()));
			assert.doesNotMatch(visibleAgain, /\x1b_Ga=[Tp],/);
			overlay.hide();
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});
});
