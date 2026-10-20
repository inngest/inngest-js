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

  return {
    name: name,
    data: Object.assign({}, evt, {
      _github: {
        event: event,
        delivery: delivery,
        installationId: installationId,
      },
    }),
  };
}
