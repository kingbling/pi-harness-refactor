/**
 * Placement facts for PHP sources (see SourceAdapter.placeFile): the surface of a file, ui or server.
 *
 * Only in a gyro app (layer-first: view/templates/…, behaviour/commands/…, model/classes/…) is the surface certain
 * from the path; elsewhere it stays unknown and Jev's has_ui label (or an area rule's stack) decides. Which area a
 * file belongs to is not guessed here: the taxonomy model writes prefix → area rules into placement.json from the
 * folder tree (src/run/taxonomy.ts), Jev places the files no rule covers.
 */

const TEMPLATE_RE = /(^|\/)(templates?|views?|resources\/views)\/|\.phtml$|\.blade\.php$|\.tpl\.php$/i;
const MAIL_RE = /(^|\/)mails?\/|\.mail\.[a-z.]*php$/i;
const GYRO_SHAPE = /(^|\/)(view\/templates|behaviour\/commands|behaviour\/accesscontrol|model\/classes|lib\/components)\//;

export function phpSurface(path: string): "server" | "ui" {
	return TEMPLATE_RE.test(path) && !MAIL_RE.test(path) ? "ui" : "server";
}

const gyroRoots = new Map<string, boolean>();
/** Undefined when the path says nothing certain (not a gyro app). The area is never set: rules and Jev decide it. */
export function placePhpFile(path: string, root: string | undefined, isGyro: (root: string) => boolean): { area?: string; surface: "server" | "ui" } | undefined {
	const gyro = root ? (gyroRoots.get(root) ?? gyroRoots.set(root, isGyro(root)).get(root)!) : GYRO_SHAPE.test(path);
	return gyro ? { surface: phpSurface(path) } : undefined;
}
