import * as fs from "node:fs";
import * as path from "node:path";

/** Turbopack's Windows junctions are not relocatable. Keep each alias's
 * nested npm resolution scope when replacing the junction with real files. */
export function materializeTracedAliases(standalone) {
	const root = fs.realpathSync(standalone);
	const modules = path.join(root, "node_modules");
	const aliases = path.join(root, ".next", "node_modules");
	const within = p => p.startsWith(root + path.sep);
	let count = 0;
	function packages(directory) {
		return fs.readdirSync(directory).filter(n => n !== ".bin").flatMap(name =>
			name.startsWith("@") ? fs.readdirSync(path.join(directory, name)).map(child => path.join(name, child)) : [name]);
	}
	function visit(directory) {
		for (const name of fs.readdirSync(directory)) {
			const alias = path.join(directory, name), stat = fs.lstatSync(alias);
			if (!stat.isSymbolicLink()) { if (stat.isDirectory()) visit(alias); continue; }
			const target = fs.realpathSync(alias);
			if (!within(alias) || !within(target) || !fs.statSync(target).isDirectory()) throw new Error(`Unsafe traced alias: ${alias}`);
			const temporary = alias + ".materializing";
			if (fs.existsSync(temporary)) throw new Error(`Existing alias stage: ${temporary}`);
			fs.cpSync(target, temporary, { recursive: true, dereference: true });
			// Dependencies beside a nested package do not resolve from the new alias.
			// The closest scope wins, exactly as in Node's original npm tree.
			for (let ancestor = path.dirname(target); ancestor !== modules && within(ancestor); ancestor = path.dirname(ancestor)) {
				if (path.basename(ancestor) !== "node_modules") continue;
				for (const dependency of packages(ancestor)) {
					const source = path.join(ancestor, dependency);
					const destination = path.join(temporary, "node_modules", dependency);
					if (fs.realpathSync(source) === target || fs.existsSync(destination)) continue;
					if (!within(fs.realpathSync(source))) throw new Error(`Dependency escaped payload: ${source}`);
					fs.cpSync(source, destination, { recursive: true, dereference: true });
				}
			}
			fs.unlinkSync(alias); // unlink the verified junction, never its target
			fs.renameSync(temporary, alias);
			count++;
		}
	}
	if (fs.existsSync(aliases)) visit(aliases);
	return count;
}
