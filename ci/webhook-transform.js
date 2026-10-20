function transform(evt, headers, queryParams, raw) {
  function header(name) {
    if (!headers) return undefined;
    var lower = name.toLowerCase();
    for (var key in headers) {
      if (key.toLowerCase() === lower) {
        var value = headers[key];
        return Array.isArray(value) ? value[0] : value;
      }
    }
    return undefined;
  }

  var event = header("x-github-event") || "unknown";
  var delivery = header("x-github-delivery");
  var name =
    evt && evt.action
      ? "github/" + event + "." + evt.action
      : "github/" + event;
  var installationId =
    evt && evt.installation && evt.installation.id
      ? evt.installation.id
      : undefined;

  var repo = evt && evt.repository ? evt.repository.full_name : undefined;
  var pullRequest = evt && evt.pull_request ? evt.pull_request : undefined;
  var number = pullRequest
    ? pullRequest.number
    : evt && evt.issue && evt.issue.pull_request
      ? evt.issue.number
      : undefined;
  var commit =
    (pullRequest && pullRequest.head && pullRequest.head.sha) ||
    (evt && evt.merge_group && evt.merge_group.head_sha) ||
    (evt && evt.check_run && evt.check_run.head_sha) ||
    (evt && evt.check_suite && evt.check_suite.head_sha) ||
    (evt && evt.after && !/^0+$/.test(evt.after) ? evt.after : undefined);
  var sessions = {};

  if (repo && number) sessions.pull_request = repo + "#" + number;
  if (commit) sessions.commit = commit;

  return {
    name: name,
    data: Object.assign({}, evt, {
      _github: {
        event: event,
        delivery: delivery,
        installationId: installationId,
      },
    }),
    meta: { sessions: sessions },
  };
}
