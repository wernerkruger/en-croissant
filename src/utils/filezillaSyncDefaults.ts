import filezillaXml from "../../filezilla_su235032.xml?raw";

/** Parsed from `filezilla_su235032.xml` in the repo (SFTP profile, not plain FTP). */
export function parseFileZillaServer(xml: string): {
    host: string;
    port: number;
    username: string;
} {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const host = doc.querySelector("Host")?.textContent?.trim() ?? "";
    const port = Number.parseInt(doc.querySelector("Port")?.textContent ?? "22", 10);
    const username = doc.querySelector("User")?.textContent?.trim() ?? "";
    return { host, port: Number.isFinite(port) && port > 0 ? port : 22, username };
}

export const filezillaSyncDefaults = parseFileZillaServer(filezillaXml);

/** Host/port/user from the FileZilla profile; password is never stored in the XML. */
export function serverDefaultsFromFileZilla(): Pick<
    typeof filezillaSyncDefaults,
    "host" | "port" | "username"
> {
    return {
        host: filezillaSyncDefaults.host,
        port: filezillaSyncDefaults.port,
        username: filezillaSyncDefaults.username,
    };
}
