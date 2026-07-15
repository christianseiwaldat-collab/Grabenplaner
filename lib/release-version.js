function normalizeVersionTag(value) {
  const text = String(value || "").trim().replace(/^v/i, "");
  const shortBeta = text.match(/^(\d+)\.(\d+)-beta$/i);
  if (shortBeta) return `${shortBeta[1]}.${shortBeta[2]}.0-beta`;
  return text;
}

function versionParts(value) {
  const match = normalizeVersionTag(value).match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : [0, 0, 0];
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function releaseTagName(release) {
  return release?.tag_name || release?.tagName || "";
}

function releaseDisplayName(release) {
  return release?.name || release?.releaseName || "";
}

function classifyRelease(release) {
  const text = `${releaseDisplayName(release)} ${releaseTagName(release)}`;
  if (/sicherheitsupdate|security(?:[ -]?update)?/i.test(text)) {
    return { kind: "security", label: "Sicherheitsupdate" };
  }
  if (/serviceupdate|wartungsupdate|hotfix|maintenance/i.test(text) || versionParts(releaseTagName(release))[2] > 0) {
    return { kind: "service", label: "Serviceupdate" };
  }
  return { kind: "feature", label: "Neue Version" };
}

function selectLatestRelease(releases = []) {
  const candidates = releases
    .filter((release) => releaseTagName(release) && !release.draft && !release.isDraft)
    .sort((a, b) => {
      const versionOrder = compareVersions(releaseTagName(b), releaseTagName(a));
      if (versionOrder) return versionOrder;
      return new Date(b.published_at || b.publishedAt || b.created_at || b.createdAt || 0)
        - new Date(a.published_at || a.publishedAt || a.created_at || a.createdAt || 0);
    });
  return candidates[0] || null;
}

module.exports = {
  classifyRelease,
  compareVersions,
  normalizeVersionTag,
  releaseTagName,
  selectLatestRelease,
  versionParts,
};
