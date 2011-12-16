var State = function(Y, gui, instance)
{
  /** Myself. */
  var _self = this;

  /** Validity flag: force reload from data server. */
  var _RELOAD = -1;

  /** Validity flag: soft reload, let browser decide whether to reload. */
  var _INVALID = 0;

  /** Validity flag: data is present and valid. */
  var _VALID = 1;

  /** Known state items. */
  var _ITEMS = [
    "whoami", "roles", "groups", "people", "sites", "site-names",
    "site-resources", "site-associations", "resource-pledges",
    "pinned-software", "site-responsibilities", "group-responsibilities"
  ];

  /** Pending XHR requests. */
  var _pending = {};

  /** The current database instance. */
  var _instance = instance;

  /** Item descriptions and their raw data. */
  var _data = {};

  /** Scheduled call to refresh view with data retrieved so far. */
  var _viewUpdateTO = null;

  /** Flag indicating whether data currently present is complete. */
  this.complete = false;

  /** Current site data organised by the tier label. */
  this.sitesByTier = {};

  /** Current site data organised by the canonical site name. */
  this.sitesByName = {};

  /** Current site data organised by the CMS site name. */
  this.sitesByCMS = {};

  /** Current people data organised by HN account. */
  this.peopleByHN = {};

  /** Current people data as a flat list. */
  this.people = [];

  /** Current people data organised by e-mail address. */
  this.peopleByMail = {};

  /** Current roles by role title. */
  this.rolesByTitle = {};

  /** Current groups by group name. */
  this.groupsByName = {};

  /** Return server data URL for resource @a name. */
  var _url = function(name)
  {
    return REST_SERVER_ROOT + "/data/" + _instance + "/" + name;
  };

  this.sortPerson = function(a, b)
  {
    return d3.ascending(a.surname, b.surname)
           || d3.ascending(a.forename, b.forename)
           || d3.ascending(a.email, b.email);
  };

  this.sortName = function(a, b)
  {
    return d3.ascending(a.name, b.name);
  };

  this.sortSite = function(a, b)
  {
    return d3.ascending(a.canonical_name, b.canonical_name);
  };

  /** Rebuild high-level data from the raw information. */
  var _rebuild = function()
  {
    var whoami = null;
    var people = [], bymail = {}, byhn = {};
    var roles = {}, groups = {};
    var tiers = {}, byname = {}, bycms = {};

    // Roles and groups.
    Y.each(_data['roles'].value || [], function(i) {
      var r = roles[i.title] = Y.merge({ members: [], site: {}, group: {} }, i);
      r.canonical_name = i.title.toLowerCase().replace(/[^a-z0-9]+/gi, "-");
    });

    Y.each(_data['groups'].value || [], function(i) {
      var g = groups[i.name] = Y.merge({ members: [] }, i);
      g.canonical_name = g.name.toLowerCase().replace(/[^a-z0-9]+/gi, "-");
    });

    // Who-am-I information.
    if (_data['whoami'].value && _data['whoami'].value.length == 1)
      whoami = Y.merge({ person: null }, _data['whoami'].value[0]);

    // People records.
    Y.each(_data['people'].value || [], function(i) {
      var p = Y.merge({ fullname: i.email, roles: {}, sites: {}, groups: {} }, i);
      if (p.im_handle)
        p.im_handle = p.im_handle.replace(/^none(:none)*$/gi, "");
      if (i.surname)
	p.fullname = i.forename + " " + i.surname;
      if (whoami && p.username == whoami.login)
	whoami.person = p;
      bymail[i.email] = p;
      byhn[i.username] = p;
      people.push(p);
    });

    // Basic site records.
    Y.each(_data['sites'].value || [], function(i) {
      var site = { cc: null, canonical_name: i.name, name_alias: {},
                   resources: { CE: [], SE: [] },
                   child_sites: [], parent_site: null,
                   resource_pledges: {}, pinned_software: {},
                   responsibilities: {} };
      site = Y.merge(site, i);

      var tier = tiers[i.tier];
      if (! tier)
        tier = tiers[i.tier] = [];
      tier.push(site);
      byname[i.name] = site;
    });

    // Site name aliases.
    Y.each(_data['site-names'].value || [], function(i) {
      if (i.site_name in byname)
      {
        var site = byname[i.site_name];
	if (! (i.type in site.name_alias))
	  site.name_alias[i.type] = [];
        site.name_alias[i.type].push(i.alias);
        if (i.type == "cms" && site.canonical_name == site.name)
        {
          site.cc = i.alias.replace(/^T\d+_([A-Z][A-Z])_.*/, "$1").toLowerCase();
          site.canonical_name = i.alias;
          bycms[i.alias] = site;
        }
      }
    });

    // Site resources (CE, SE).
    Y.each(_data['site-resources'].value || [], function(i) {
      if (i.name in byname)
      {
        var res = byname[i.name].resources;
        if (! (i.type in res))
	  res[i.type] = [];
        res[i.type].push(i);
      }
    });

    // Site parent/child associations.
    Y.each(_data['site-associations'].value || [], function(i) {
      if (i.parent_site in byname && i.child_site in byname)
      {
        var parent = byname[i.parent_site];
        var child = byname[i.child_site];
        parent.child_sites.push(child);
        child.parent_site = parent;
      }
    });

    // Site resource pledges; keep only the most recent one per quarter.
    Y.each(_data['resource-pledges'].value || [], function(i) {
      if (i.site in byname)
      {
        var pledges = byname[i.site].resource_pledges;
        if (! (i.quarter in pledges)
            || pledges[i.quarter].pledge_date < i.pledge_date)
	  pledges[i.quarter] = i;
      }
    });

    // Pinned software.
    Y.each(_data['pinned-software'].value || [], function(i) {
      if (i.site in byname)
      {
        var pins = byname[i.site].pinned_software;
        if (! (i.ce in pins))
	  pins[i.ce] = [];
	pins[i.ce].push(i);
      }
    });

    // Site responsibilities; associates site, role and person.
    Y.each(_data['site-responsibilities'].value || [], function(i) {
      if (i.site in byname && i.email in bymail && i.role in roles)
      {
        var site = byname[i.site];
	var role = roles[i.role];
        var person = bymail[i.email];

        var r = site.responsibilities;
        if (! (i.role in r))
	  r[i.role] = [];
	r[i.role].push(person);

        r = person.roles;
        if (! (i.role in r))
	  r[i.role] = { site: [], group: [] };
	r[i.role].site.push(site);

	if (! (i.site in role.site))
          role.site[i.site] = [];
        role.site[i.site].push(person);
      }
    });

    // Group responsibilities; associates group, role and person.
    Y.each(_data['group-responsibilities'].value || [], function(i) {
      if (i.user_group in groups && i.email in bymail && i.role in roles)
      {
        var group = groups[i.user_group];
	var role = roles[i.role];
        var person = bymail[i.email];

        group.members.push(person);

        r = person.roles;
        if (! (i.role in r))
	  r[i.role] = { site: [], group: [] };
	r[i.role].group.push(group);

	if (! (i.user_group in role.group))
          role.group[i.user_group] = [];
        role.group[i.user_group].push(person);
      }
    });

    // All data processed, now sort regularly used data structures.
    // Put various site and people names into reasonably natural order.
    people.sort(_self.sortPerson);
    Y.each(roles, function(role) {
      var members = {};
      Y.each(role.site, function(v) {
        Y.each(v, function(p) { members[p.email] = p; });
        v.sort(_self.sortSite);
      });
      Y.each(role.group, function(v) {
        Y.each(v, function(p) { members[p.email] = p; });
        v.sort(_self.sortName);
      });
      role.members = Y.Object.values(members);
      role.members.sort(_self.sortPerson);
    });

    Y.each(groups, function(group) {
      var members = {};
      Y.each(group.members, function(p) { members[p.email] = p; });
      group.members = Y.Object.values(members);
      group.members.sort(_self.sortPerson);
    });

    Y.each(bymail, function(person) {
      Y.each(person.roles, function(v) {
        v.site.sort(_self.sortSite);
        v.group.sort(function(a, b) { return d3.ascending(a.name, b.name); });
        Y.each(v.site, function(s) { person.sites[s.canonical_name] = s; });
        Y.each(v.group, function(g) { person.groups[g.name] = g; });
      });
    });

    Y.each(tiers, function(sites) {
      sites.sort(_self.sortSite);
      Y.each(sites, function(s) {
        Y.each(s.responsibilities, function(v) { v.sort(_self.sortPerson); });
        Y.each(s.name_alias, function(v) { v.sort(d3.ascending); });
        s.child_sites.sort(_self.sortSite);

        Y.each(s.resources, function(v) {
          v.sort(function(a, b) { return d3.ascending(a.fqdn, b.fqdn); });
        });

        Y.each(s.pinned_software, function(v) {
          v.sort(function(a, b) {
            return d3.descending(a.arch, b.arch)
                   || d3.descending(a.release, b.release); });
        });
      });
    });

    _self.sitesByTier = tiers;
    _self.sitesByName = byname;
    _self.sitesByCMS = bycms;
    _self.people = people;
    _self.peopleByHN = byhn;
    _self.peopleByMail = bymail;
    _self.rolesByTitle = roles;
    _self.groupsByName = groups;
    _self.whoami = whoami;
  };

  /** Final handler for state update. Rebuilds high-level data and calls
      the GUI view update. */
  var _rebuildAndUpdate = function()
  {
    _rebuild();
    gui.update.call(gui);
    _viewUpdateTO = null;
  };

  /** Complete fetching the request @a i. Marks the object valid and removes
      the XHR pending object for it. Marks state complete if no more data is
      pending download. Calls _rebuildAndUpdate if state has become complete,
      otherwise schedules the call if no further updates arrive within 500 ms. */
  var _complete = function(i)
  {
    i.obj.node.setAttribute("class", "valid");
    i.obj.valid = _VALID;
    delete _pending[i.name];

    _self.complete = true;
    for (var name in _data)
      if (_data[name].valid != _VALID || name in _pending)
        _self.complete = false;

    if (_self.complete)
      _rebuildAndUpdate();
    else if (! _viewUpdateTO)
      _viewUpdateTO = Y.later(500, _self, _rebuildAndUpdate);
  };

  /** Utility function to abort all pending GET requests. */
  var _abort = function()
  {
    for (var p in _pending)
      _pending[p].abort();
    _pending = {};
  };

  /** Report a data server interaction error. */
  var _error = function(file, line, category, message)
  {
    _abort();
    for (var name in _data)
      _data[name].valid = _RELOAD;

    gui.errorReport(10000, file, line, "state", category, message);
  };

  /** Handle successfully retrieved data. */
  var _success = function(id, o, i)
  {
    var hash = Y.Array.hash;

    try
    {
      var ctype = o.getResponseHeader("Content-Type");
      if (o.status == 304)
      {
        _complete(i);
      }
      else if (o.status != 200)
      {
        i.obj.node.setAttribute("class", "invalid");
        _error("(state)", 0, "bad-status", "Internal error retrieving '"
               + Y.Escape.html(i.name)
               + "': success handler called with status code " + o.status
               + " != 200 ('" + Y.Escape.html(o.statusText) + "')");
      }
      else if (ctype != "application/json")
      {
        i.obj.node.setAttribute("class", "invalid");
        _error("(state)", 0, "bad-ctype", "Internal error retrieving '"
               + Y.Escape.html(i.name)
               + "': expected 'application/json' reply, got '"
               + Y.Escape.html(ctype) + "'");
      }
      else
      {
        var val = Y.JSON.parse(o.responseText);
        if (val.result && val.desc && val.desc.columns)
        {
          i.obj.value = val.result.map(function(e) {
            return hash(val.desc.columns, e); });
          _complete(i);
        }
        else if (val.result)
        {
          i.obj.value = val.result;
          _complete(i);
        }
        else
        {
          i.obj.node.setAttribute("class", "error");
          _error("(state)", 0, "bad-json", "Internal error retrieving '"
                 + Y.Escape.html(i.name) + "': failed to parse json result");
        }
      }
    }
    catch (err)
    {
      i.obj.node.setAttribute("class", "error");

      var fileName = (err.fileName ? err.fileName.replace(/.*\//, "") : "(unknown)");
      var lineNumber = (err.lineNumber ? err.lineNumber : 0);
      var fileLoc = Y.Escape.html(fileName) + lineNumber;
      _error(fileName, lineNumber, "exception", "An exception '"
             + Y.Escape.html(err.name) + "' was raised during page update: "
             + Y.Escape.html(err.message));
    }
  };

  /** Handle failure to retrieve data from the server. */
  var _failure = function(id, o, i)
  {
    if (o.status === 0 && o.statusText == "abort")
      return;

    _error("(state)", 0, "comm-error", "Communication failure with the SiteDB"
           + " server: " + Y.Escape.html(o.statusText) + " (HTTP status "
           + o.status + ") while retrieving '" + Y.Escape.html(i.name) + "'");
  };

  /** Issue a server request for @a name and @a obj in @a state. */
  var _refresh = function(name, obj, state)
  {
    // Mark state incomplete.
    _self.complete = false;

    // Mark object invalid if previously valid, but don't undo forced reload.
    // The caller will use _RELOAD or _INVALID as state as appropriate.
    if (obj.valid > state)
      obj.valid = state;

    // If there's already pending operation to load it, cancel it. Callers
    // are smart enough to avoid this in case they don't want this behaviour.
    if (name in _pending)
    {
      _pending[name].abort();
      delete _pending[name];
    }

    // Mark the object in pending state in debug display.
    obj.node.setAttribute("class", "pending");

    // Set request headers. We always add the 'Accept' header. We also add
    // 'Cache-Control' header if we want to force redownload. Note that the
    // browser will automatically add 'If-None-Match' header if it has an
    // existing but out-of-date object with 'ETag' header.
    //
    // Note that the browser will happily return data to us from its cache
    // as long as it's within the expire time limits, without checking with
    // the server (= without doing a conditional GET). This is what we want,
    // and we force reload when we know we want to avoid stale data. We end
    // up here forcing reload on a) the first page load, b) whenever switching
    // instances. The expire limits on SiteDB objects are short enough that
    // this is precisely the behaviour we want.
    var headers = { "Accept": "application/json" };
    if (obj.valid == _RELOAD)
      headers["Cache-Control"] = "max-age=0, must-revalidate";

    // Start XHR I/O on this object.
    _pending[name] = Y.io(_url(name),
                          { on: { success: _success, failure: _failure },
                            context: this, method: "GET", sync: false,
                            timeout: null, arguments: { obj: obj, name: name },
                            headers: headers });
  };

  /** Check if the user has @a role in @a group. */
  this.hasGroupRole = function(role, group)
  {
    var roles = _self.whoami && _self.whoami.roles;
    role = role.toLowerCase().replace(/[^a-z0-9]+/gi, "-");
    group = group.toLowerCase().replace(/[^a-z0-9]+/gi, "-");
    if (roles && role in roles)
    {
      var groups = roles[role]["group"];
      for (var i = 0; i < groups.length; ++i)
	if (groups[i] == group)
	  return true;
    }

    return false;
  };

  /** Check if the user has @a role for @a site. */
  this.hasSiteRole = function(role, site)
  {
    var roles = _self.whoami && _self.whoami.roles;
    role = role.toLowerCase().replace(/[^a-z0-9]+/gi, "-");
    site = site.toLowerCase().replace(/[^a-z0-9]+/gi, "-");
    if (roles && role in roles)
    {
      var sites = roles[role]["site"];
      for (var i = 0; i < sites.length; ++i)
	if (sites[i] == group)
	  return true;
    }

    return false;
  };

  /** Check if the user is a global admin. */
  this.isGlobalAdmin = function()
  {
    return _self.hasGroupRole("global-admin", "global");
  };

  /** Require list of state elements to be loaded. Refreshes those that
      are out of date and not currently pending load. */
  this.require = function()
  {
    for (var i = 0; i < arguments.length; ++i)
    {
      var name = arguments[i];
      var pending = (name in _pending);
      var obj = _data[name];
      if (obj.valid != _VALID && ! pending)
        _refresh(name, obj, _INVALID);
    }

    return _self;
  };

  /** Require all state items. */
  this.requireall = function()
  {
    return _self.require.apply(_self, _ITEMS);
  };

  /** Invalidate all state items so they will be retrieved again on the
      next 'require()'. Does not force them to be redownloaded from the
      server, but will ask browser to get the data again. This allows the
      browser to check with the server for updates on expired data. */
  this.invalidate = function()
  {
    for (var name in _data)
    {
      var obj = _data[name];
      obj.node.setAttribute("class", "");
      obj.valid = _INVALID;
    }

    return _self;
  };

  /** Force the provided list of state elements to refresh.
  this.refresh = function()
  {
    for (var i = 0; i < arguments.length; ++i)
      _refresh(name, _data[arguments[i]], _RELOAD);
  }; */

  /** Get the current instance. */
  this.currentInstance = function()
  {
    return _instance;
  };

  /** Switch data to another instance. This invalidates all data and
      forces them to be reloaded on the next access, but does not yet
      issue requests for them. */
  this.instance = function(value)
  {
    if (_instance != value)
    {
      _instance = value;

      for (var name in _data)
      {
        var obj = _data[name];
        obj.node.setAttribute("class", "");
        obj.valid = _RELOAD;
        obj.value = null;
      }

      _abort();
    }
  };

  /** Add state elements from _ITEMS, with debug indicator under @a debug. */
  this.start = function(debug)
  {
    Y.each(_ITEMS, function(name) {
      var n = debug.one("#debug-data-" + name);
      if (! n)
      {
        n = Y.Node.create("<p id='#debug-data-" + name + "'>" + name + "</p>");
        debug.append(n);
      }

      _data[name] = { valid: false, value: null, node: n };
    });
  };

  return this;
};