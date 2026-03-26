import fs from "node:fs";
import inspector from "node:inspector";
import path from "node:path";
import process from "node:process";

export async function withProfiling<T>(
	outputName: string,
	fn: () => Promise<T>,
): Promise<{ result: T; profilePath: string }> {
	const session = new inspector.Session();
	session.connect();

	await new Promise<void>((resolve, reject) => {
		session.post("Profiler.enable", (err) => {
			if (err) {
				reject(err);
			} else {
				session.post("Profiler.start", (err2) => {
					if (err2) {
						reject(err2);
					} else {
						resolve();
					}
				});
			}
		});
	});

	try {
		const result = await fn();
		return await new Promise((resolve, reject) => {
			session.post("Profiler.stop", (err, { profile }) => {
				if (err) {
					reject(err);
					return;
				}
				const profilePath = path.resolve(
					process.cwd(),
					`${outputName}.cpuprofile`,
				);
				fs.writeFileSync(profilePath, JSON.stringify(profile));
				session.disconnect();
				resolve({ result, profilePath });
			});
		});
	} catch (e) {
		session.disconnect();
		throw e;
	}
}
