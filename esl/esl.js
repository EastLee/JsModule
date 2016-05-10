var define;
var require;

(function(global) {

  var modModules = {};

  var modModuleList = [];

  var autoDefineModules = {};

  //加载的各个状态
  var MODULE_PRE_DEFINED = 1;
  var MODULE_ANALYZED = 2;
  var MODULE_PREPARED = 3;
  var MODULE_DEFINED = 4;

  //返回baseId为空或者不为空的两种req
  function createLocalRequire(baseId) {
    var requiredCache = {};

    function req(requireId, callback) {
      if (typeof requireId === 'string') { //获得requireId的exports
        if (!requiredCache[requireId]) {
          requiredCache[requireId] = nativeRequire(normalize(requireId, baseId));
        }
        return requiredCache[requireId];
      } else if (requireId instanceof Array) {

        var pluginModules = [];
        var pureModules = [];
        var normalizedIds = [];

        each(requireId, function(id, i) {
            var idInfo = parseId(id);
            var absId = normalize(idInfo.module, baseId);
            pureModules.push(absId);
            autoDefineModules[absId] = 1; //这里会把require中的数组参数放入autoDefineModules中
            if (idInfo.resource) {
              pluginModules.push(absId);
              normalizedIds[i] = null;
            } else {
              normalizedIds[i] = absId;
            }
          });

        var noRequestModules = {};
        each(pureModules, function(id) {
            var meet;
            // noRequestsIndex = [{reg:xx,k:xx,v:xx}]
            indexRetrieve(id, noRequestsIndex, function(value) {
                meet = value;
            });

            if (meet) {
              if (meet['*']) {
                noRequestModules[id] = 1;
              } else {
                each(pureModules, function(meetId) {
                  if (meet[meetId]) {
                    noRequestModules[id] = 1;
                    return false;
                  }
                });
              }
            }
          });

        nativeRequire(
          pureModules,
          function() { //require回调函数所在
            each(normalizedIds, function(id, i) {
              if (id == null) {
                normalizedIds[i] = normalize(requireId[i], baseId); // 对有感叹号的id做处理
              }
            });

            nativeRequire(normalizedIds, callback, baseId);
          },
          baseId,
          noRequestModules
        );
      }
    }

    req.toUrl = function(id) {
      return toUrl(normalize(id, baseId));
    };

    return req;
  }

  //req baseId == undefined
  var actualGlobalRequire = createLocalRequire();

  var waitTimeout;

  //require函数，如果requireId存在.就抛出异常；最后执行actualGlobalRequire
  function require(requireId, callback) {
    var invalidIds = [];

    function monitor(id) {
      if (id.indexOf('.') === 0) {
        invalidIds.push(id);
      }
    }

    if (typeof requireId === 'string') {
      monitor(requireId);
    } else {
      each(requireId, function(id) {
          monitor(id);
        }
      );
    }

    if (invalidIds.length > 0) {
      throw new Error('[REQUIRE_FATAL]Relative ID is not allowed in global require: ' + invalidIds.join(', '));
    }

    var timeout = requireConf.waitSeconds;
    if (timeout && (requireId instanceof Array)) {
      if (waitTimeout) {
        clearTimeout(waitTimeout);
      }
      waitTimeout = setTimeout(waitTimeoutNotice, timeout * 1000);
    }

    return actualGlobalRequire(requireId, callback);
  }

  require.toUrl = actualGlobalRequire.toUrl;

  function waitTimeoutNotice() {
    var hangModules = [];
    var missModules = [];
    var hangModulesMap = {};
    var missModulesMap = {};
    var visited = {};

    function checkError(id, hard) {
      if (visited[id] || modIs(id, MODULE_DEFINED)) {
        return;
      }

      visited[id] = 1;

      if (!modIs(id, MODULE_PREPARED)) {
        // HACK: 为gzip后体积优化，不做抽取
        if (!hangModulesMap[id]) {
          hangModulesMap[id] = 1;
          hangModules.push(id);
        }
      }

      var module = modModules[id];
      if (!module) {
        if (!missModulesMap[id]) {
          missModulesMap[id] = 1;
          missModules.push(id);
        }
      } else if (hard) {
        if (!hangModulesMap[id]) {
          hangModulesMap[id] = 1;
          hangModules.push(id);
        }

        each(
          module.depMs,
          function(dep) {
            checkError(dep.absId, dep.hard);
          }
        );
      }
    }

    for (var id in autoDefineModules) {
      checkError(id, 1);
    }

    if (hangModules.length || missModules.length) {
      throw new Error('[MODULE_TIMEOUT]Hang( ' + (hangModules.join(', ') || 'none') + ' ) Miss( ' + (missModules.join(', ') || 'none') + ' )');
    }
  }

  var tryDefineTimeout;

  function define() {
    var argsLen = arguments.length;
    if (!argsLen) {
      return;
    }

    var id;
    var dependencies;
    //最后一个是回调函数
    var factory = arguments[--argsLen];

    //其余的 如果是字符串就是id 如果是数组就是依赖
    while (argsLen--) {
      var arg = arguments[argsLen];

      if (typeof arg === 'string') {
        id = arg;
      } else if (arg instanceof Array) {
        dependencies = arg;
      }
    }

    var opera = window.opera;

    // IE下通过current script的data-require-id获取当前id
    if (!id && document.attachEvent && (!(opera && opera.toString() === '[object Opera]'))) {
      var currentScript = getCurrentScript();
      id = currentScript && currentScript.getAttribute('data-require-id');
    }

    if (id) {
      modPreDefine(id, dependencies, factory);

      if (tryDefineTimeout) {
        clearTimeout(tryDefineTimeout);
      }
      tryDefineTimeout = setTimeout(modAnalyse, 1);
    } else {

      wait4PreDefine[0] = {
        deps: dependencies,
        factory: factory
      };
    }
  }

  define.amd = {};

  //返回requireConf中的config，config必须是对象
  function moduleConfigGetter() {
    var conf = requireConf.config[this.id];
    if (conf && typeof conf === 'object') {
      return conf;
    }
    return {};
  }

  //将模块推入数组中存起来
  function modPreDefine(id, dependencies, factory) {

    if (!modModules[id]) {
      var module = {
        id: id,
        depsDec: dependencies,
        deps: dependencies || ['require', 'exports', 'module'],
        factoryDeps: [],
        factory: factory,
        exports: {},
        config: moduleConfigGetter,
        state: MODULE_PRE_DEFINED,
        require: createLocalRequire(id),
        depMs: [],
        depMkv: {},
        depRs: [],
        depPMs: []
      };

      modModules[id] = module;
      modModuleList.push(module);
    }
  }

  //将每个模块的实际用到的依赖的模块信息放在factoryDeps中，并且挂载invokeFactory，设置模块的状态为MODULE_ANALYZED，执行modAutoInvoke
  function modAnalyse() {
    var requireModules = [];
    var requireModulesIndex = {};

    //把不在modModules中的模块放入requireModules中
    function addRequireModule(id) {
      if (modModules[id] || requireModulesIndex[id]) {
        return;
      }

      requireModules.push(id);
      requireModulesIndex[id] = 1;
    }

    //初始化后第一次对每个模块进行处理
    each(modModuleList, function(module) {
      if (module.state > MODULE_PRE_DEFINED) {
        return;
      }

      var deps = module.deps;
      var hardDependsCount = 0;
      var factory = module.factory;

      if (typeof factory === 'function') {
        hardDependsCount = Math.min(factory.length, deps.length); //回调函数的factory的形参代表依赖的模块数量 执行时实际依赖的模块数量

        !module.depsDec && factory.toString()
          .replace(/(\/\*([\s\S]*?)\*\/|([^:]|^)\/\/(.*)$)/mg, '') //删除注释（双斜杠注释时，双斜杠前面第一个字符也会被删除）
          .replace(/require\(\s*(['"'])([^'"]+)\1\s*\)/g, //将回调函数体中的require的模块放入deps中（这个模块只能是一个并且是字符串形式）
            function($0, $1, depId) {
              deps.push(depId);
            }
          );
      }

      //对每个模块依赖的模块进行处理
      each(deps, function(depId, index) {
        var idInfo = parseId(depId);
        var absId = normalize(idInfo.module, module.id);
        var moduleInfo, resInfo;

        if (absId && !BUILDIN_MODULE[absId]) {

          if (idInfo.resource) {
            resInfo = {
              id: depId, //子模块id
              module: absId, //经过相对路径处理的绝对路径
              resource: idInfo.resource //感叹号后面的
            };
            autoDefineModules[absId] = 1;
            module.depPMs.push(absId);
            module.depRs.push(resInfo);
          }

          moduleInfo = module.depMkv[absId];
          if (!moduleInfo) {
            moduleInfo = {
              id: idInfo.module,
              absId: absId,
              hard: index < hardDependsCount //当依赖模块数量比回调函数的形参多
            };
            module.depMs.push(moduleInfo);
            module.depMkv[absId] = moduleInfo;
            addRequireModule(absId);
          }
        } else {
          moduleInfo = {
            absId: absId
          };
        }

        if (index < hardDependsCount) {
          module.factoryDeps.push(resInfo || moduleInfo); //将实际依赖的模块信息存放到factoryDeps
        }
      });

      //处理了依赖的模块 状态可以设置为第二状态
      module.state = MODULE_ANALYZED;
      modInitFactoryInvoker(module.id);
    });

    modAutoInvoke(); //将autoDefineModules中的模块状态设置为MODULE_PREPARED，并且执行invokeFactory
    nativeRequire(requireModules); //处理require引入的入口define文件依赖的模块
  }

  //核心函数 递归设置所有模块状态为3，递归执行所有invokeFactory
  function modAutoInvoke() {
    for (var id in autoDefineModules) { //含有感叹号的模块
      modUpdatePreparedState(id); //一次性设置有依赖关系的模块为状态3
      modTryInvokeFactory(id);
    }
  }

  //检测模块的所有依赖都达到MODULE_PREPARED，此时这个模块才能设置为MODULE_PREPARED
  //更可以将所有有依赖关系的模块一次性设置为MODULE_PREPARED
  function modUpdatePreparedState(id) {
    var visited = {};
    update(id);

    function update(id) {
      if (!modIs(id, MODULE_ANALYZED)) { //状态只在MODULE_PRE_DEFINED触发
        return false;
      }
      if (modIs(id, MODULE_PREPARED) || visited[id]) { //状态在MODULE_PREPARED或之上直接返回
        return true;
      }

      visited[id] = 1;
      var module = modModules[id];
      var prepared = true;

      each(module.depMs, function(dep) { //递归所有的依赖的都至少达到了MODULE_ANALYZED
          return (prepared = update(dep.absId));
        }
      );

      prepared && each(module.depRs, function(dep) { //递归所有有感叹号的依赖，都至少达到了MODULE_DEFINED
          prepared = !!(dep.absId && modIs(dep.absId, MODULE_DEFINED));
          return prepared;
        }
      );

      if (prepared) {
        module.state = MODULE_PREPARED;
      }

      return prepared;
    }
  }

  //模块挂载invokerFactory
  function modInitFactoryInvoker(id) {
    var module = modModules[id];
    var invoking;

    module.invokeFactory = invokeFactory;
    each(module.depPMs, function(pluginModuleId) { //为依赖模块名字中含有感叹号的添加listener
      modAddDefinedListener(pluginModuleId, function() {
        each(module.depRs, function(res) {
          if (!res.absId && res.module === pluginModuleId) {
            res.absId = normalize(res.id, id);
            nativeRequire([res.absId], modAutoInvoke);
          }
        });
      });
    });

    //执行每个模块的回调函数，设置每个模块的exports，最后设置MODULE_DEFINED状态并且执行监听函数
    function invokeFactory() {
      if (invoking || module.state !== MODULE_PREPARED) { //模块状态必须是MODULE_PREPARED
        return;
      }

      invoking = 1;
      var factoryReady = 1;
      var factoryDeps = [];
      each(module.factoryDeps, function(dep) {
          var depId = dep.absId;
          if (!BUILDIN_MODULE[depId]) {
            modTryInvokeFactory(depId); //递归执行依赖模块的invokeFactory
            if (!modIs(depId, MODULE_DEFINED)) { //所有依赖的模块必须达到MODULE_DEFINED
              factoryReady = 0;
              return false;
            }
          }

          factoryDeps.push(depId); //达到MODULE_DEFINED状态的模块被推入factoryDeps中
        }
      );
      //所有依赖的模块必须达到MODULE_DEFINED就可以执行下面的代码
      if (factoryReady) {
        try {
          var args = modGetModulesExports( //依赖模块的输出
            factoryDeps, {
              require: module.require,
              exports: module.exports,
              module: module
            }
          );

          var factory = module.factory;
          var exports = typeof factory === 'function' ? factory.apply(global, args) : factory;

          if (exports != null) {
            module.exports = exports;
          }

          module.invokeFactory = null;
        } catch (ex) {
          invoking = 0;
          if (/^\[MODULE_MISS\]"([^"]+)/.test(ex.message)) {
            var hardCirclurDep = module.depMkv[RegExp.$1];
            hardCirclurDep && (hardCirclurDep.hard = 1);
            return;
          }
          throw ex;
        }
        modDefined(id);
      }
    }
  }

  //判断模块此时的状态至少是state
  function modIs(id, state) {
    return modModules[id] && modModules[id].state >= state;
  }

  //执行模块的invokeFactory
  function modTryInvokeFactory(id) {
    var module = modModules[id];

    if (module && module.invokeFactory) {
      module.invokeFactory();
    }
  }

  //获取一组模块的输出
  function modGetModulesExports(modules, buildinModules) {
    var args = [];
    each(modules, function(id, index) {
        args[index] = buildinModules[id] || modGetModuleExports(id);
      }
    );

    return args;
  }

  var modDefinedListeners = {};

  //增加监听函数
  function modAddDefinedListener(id, listener) {
    if (modIs(id, MODULE_DEFINED)) {
      listener();
      return;
    }

    var listeners = modDefinedListeners[id];
    if (!listeners) {
      listeners = modDefinedListeners[id] = [];
    }

    listeners.push(listener);
  }

  //设置模块的状态为MODULE_DEFINED，执行监听函数
  function modDefined(id) {
    var listeners = modDefinedListeners[id] || [];
    var module = modModules[id];
    module.state = MODULE_DEFINED;

    var len = listeners.length;
    while (len--) {
      listeners[len]();
    }

    listeners.length = 0;
    delete modDefinedListeners[id];
  }

  //获取模块的输出
  function modGetModuleExports(id) {
    if (modIs(id, MODULE_DEFINED)) {
      return modModules[id].exports;
    }

    return null;
  }

  var BUILDIN_MODULE = {
    require: require,
    exports: 1,
    module: 1
  };

  var wait4PreDefine = [];

  //将模块加入modModules中，并且调用modAnalyse处理
  function completePreDefine(currentId) {
    // HACK: 这里在IE下有个性能陷阱，不能使用任何变量。
    //       否则貌似会形成变量引用和修改的读写锁，导致wait4PreDefine释放困难
    each(wait4PreDefine, function(module) { //wait4PreDefine只有一个元素
      //needAnalyse = 1;
      modPreDefine(currentId, module.deps, module.factory);
    });
    wait4PreDefine.length = 0;
    modAnalyse();
  }

  //如果ids是字符串，返回该模块的exports，如果是数组，ids的状态为MODULE_DEFINED，执行callback，如果存在状态不是为MODULE_DEFINED的模块，再进一步处理
  function nativeRequire(ids, callback, baseId, noRequests) {
    if (typeof ids === 'string') { //如果ids是字符串，模块的状态必须是MODULE_PREPARED
      modTryInvokeFactory(ids); //执行模块的invokeFactory
      if (!modIs(ids, MODULE_DEFINED)) { //状态必须是 MODULE_DEFINED
        throw new Error('[MODULE_MISS]"' + ids + '" is not exists!');
      }

      return modGetModuleExports(ids); //返回模块的exports
    }

    noRequests = noRequests || {};
    var isCallbackCalled = 0;
    if (ids instanceof Array) {
      modAutoInvoke();
      tryFinishRequire(); //如果状态都是MODULE_DEFINED，在此处就结束

      if (!isCallbackCalled) {
        each(ids, function(id) {
          if (!(BUILDIN_MODULE[id] || modIs(id, MODULE_DEFINED))) {
            modAddDefinedListener(id, tryFinishRequire); //为没有达到MODULE_DEFINED的模块增加监听函数
            if (!noRequests[id]) {
              (id.indexOf('!') > 0 ? loadResource : loadModule)(id, baseId);
            }
          }
        });
      }
    }

    //ids中每个模块达到MODULE_DEFINED，并且执行callback
    function tryFinishRequire() {
      if (!isCallbackCalled) {
        var isAllCompleted = 1;
        each(ids, function(id) {
          if (!BUILDIN_MODULE[id]) {
            return (isAllCompleted = !!modIs(id, MODULE_DEFINED));
          }
        });

        if (isAllCompleted) {
          isCallbackCalled = 1;
          (typeof callback === 'function') && callback.apply(global,modGetModulesExports(ids, BUILDIN_MODULE));
        }
      }
    }
  }

  // 下载的define模块的容器
  var loadingModules = {};

  //插入script标签（之前没有加入modModules数组的模块，现在重新加入）
  function loadModule(moduleId) {
    if (loadingModules[moduleId] || modModules[moduleId]) { //没有下载define文件 当然就没有push进modModules
      return;
    }

    loadingModules[moduleId] = 1;

    var script = document.createElement('script');
    script.setAttribute('data-require-id', moduleId);
    //变成绝对的url
    script.src = toUrl(moduleId + '.js');
    script.async = true;
    if (script.readyState) {
      script.onreadystatechange = loadedListener;
    } else {
      script.onload = loadedListener;
    }
    appendScript(script);

    function loadedListener() {
      var readyState = script.readyState;
      if (typeof readyState === 'undefined' || /^(loaded|complete)$/.test(readyState)) {
        script.onload = script.onreadystatechange = null;
        script = null;
        completePreDefine(moduleId);
      }
    }
  }

  function loadResource(pluginAndResource, baseId) {
    if (modModules[pluginAndResource]) {
      return;
    }

    var idInfo = parseId(pluginAndResource);
    var resource = {
      id: pluginAndResource,
      state: MODULE_ANALYZED
    };
    modModules[pluginAndResource] = resource;

    function pluginOnload(value) {
      resource.exports = value || true;
      modDefined(pluginAndResource);
    }

    pluginOnload.fromText = function(id, text) {
      autoDefineModules[id] = 1;
      new Function(text)();
      completePreDefine(id);
    };

    function load(plugin) {
      var pluginRequire = baseId ? modModules[baseId].require : actualGlobalRequire;

      plugin.load(
        idInfo.resource,
        pluginRequire,
        pluginOnload,
        moduleConfigGetter.call({
          id: pluginAndResource
        })
      );
    }

    load(modGetModuleExports(idInfo.module));
  }

  var requireConf = {
    baseUrl: './',
    paths: {},
    config: {},
    map: {},
    packages: [],
    waitSeconds: 0,
    noRequests: {},
    urlArgs: {}
  };

  //配置requireConf
  require.config = function(conf) {
    function mergeArrayItem(item) {
      oldValue.push(item);
    }

    for (var key in requireConf) {
      var newValue = conf[key];
      var oldValue = requireConf[key];

      if (newValue) {
        if (key === 'urlArgs' && typeof newValue === 'string') {
          defaultUrlArgs = newValue;
        } else {
          // 简单的多处配置还是需要支持，所以配置实现为支持二级mix
          if (typeof oldValue === 'object') {
            if (oldValue instanceof Array) {
              each(newValue, mergeArrayItem);
            } else {
              for (var key in newValue) {
                oldValue[key] = newValue[key];
              }
            }
          } else {
            requireConf[key] = newValue;
          }
        }
      }
    }

    createConfIndex();
  };

  createConfIndex();

  var pathsIndex;

  var packagesIndex;

  var mappingIdIndex;

  var defaultUrlArgs;

  var urlArgsIndex;

  var noRequestsIndex;

  //创建排序好的对象数组
  function createKVSortedIndex(value, allowAsterisk) {
    var index = kv2List(value, 1, allowAsterisk);
    index.sort(descSorterByKOrName);
    return index;
  }

  //初始化requireConf
  function createConfIndex() {
    requireConf.baseUrl = requireConf.baseUrl.replace(/\/$/, '') + '/';

    pathsIndex = createKVSortedIndex(requireConf.paths);

    mappingIdIndex = createKVSortedIndex(requireConf.map, 1);
    each(mappingIdIndex, function(item) {
        item.v = createKVSortedIndex(item.v);
      }
    );

    packagesIndex = [];
    each(requireConf.packages, function(packageConf) {
        var pkg = packageConf;
        if (typeof packageConf === 'string') {
          pkg = {
            name: packageConf.split('/')[0],
            location: packageConf,
            main: 'main'
          };
        }

        pkg.location = pkg.location || pkg.name;
        pkg.main = (pkg.main || 'main').replace(/\.js$/i, '');
        pkg.reg = createPrefixRegexp(pkg.name);
        packagesIndex.push(pkg);
      }
    );
    packagesIndex.sort(descSorterByKOrName);

    urlArgsIndex = createKVSortedIndex(requireConf.urlArgs);

    noRequestsIndex = createKVSortedIndex(requireConf.noRequests);
    each(noRequestsIndex, function(item) {
      var value = item.v;
      var mapIndex = {};
      item.v = mapIndex;

      if (!(value instanceof Array)) {
        value = [value];
      }

      each(value, function(meetId) {
        mapIndex[meetId] = 1;
      });
    });
  }

  //在index中寻找value，然后把命中的那组对象传入hitBehavior
  function indexRetrieve(value, index, hitBehavior) {
    each(index, function(item) {
      if (item.reg.test(value)) {
        hitBehavior(item.v, item.k, item);
        return false;
      }
    });
  }

  //处理最后的url
  function toUrl(source) {
    var extReg = /(\.[a-z0-9]+)$/i; //后缀
    var queryReg = /(\?[^#]*)$/; //查询部分
    var extname = '';
    var id = source;
    var query = '';

    if (queryReg.test(source)) {
      query = RegExp.$1;
      source = source.replace(queryReg, '');
    }

    if (extReg.test(source)) {
      extname = RegExp.$1;
      id = source.replace(extReg, '');
    }

    var url = id;

    // paths处理和匹配
    var isPathMap;
    // 将url中的key用pathsIndex中value替换
    indexRetrieve(id, pathsIndex, function(value, key) {
      url = url.replace(key, value);
      isPathMap = 1;
    });

    // 如果pathsIndex没有匹配，就用packagesIndex处理url；packagesIndex=[{reg:xx,k:xx,v:xx,name:xx,main:xx,location:xx}]
    if (!isPathMap) {
      indexRetrieve(id, packagesIndex, function(value, key, item) {
        url = url.replace(item.name, item.location);
      });
    }

    // 相对路径时，附加baseUrl(url前面不能有"/")
    if (!/^([a-z]{2,10}:\/)?\//i.test(url)) {
      url = requireConf.baseUrl + url;
    }

    // 把后缀和查询字段重新拼接上
    url += extname + query;

    // 拼接查询字段，如果urlArgsIndex拼接了，defaultUrlArgs就不用拼接
    var isUrlArgsAppended;
    indexRetrieve(id, urlArgsIndex, function(value) {
      appendUrlArgs(value);
    });
    defaultUrlArgs && appendUrlArgs(defaultUrlArgs);

    function appendUrlArgs(args) {
      if (!isUrlArgsAppended) {
        url += (url.indexOf('?') > 0 ? '&' : '?') + args;
        isUrlArgsAppended = 1;
      }
    }

    return url;
  }

  //将id变成相对于baseId的绝对路径
  function normalize(id, baseId) {
    if (!id) {
      return '';
    }

    baseId = baseId || '';
    var idInfo = parseId(id);
    if (!idInfo) {
      return id;
    }

    var resourceId = idInfo.resource;
    var moduleId = relative2absolute(idInfo.module, baseId);

    //packagesIndex中某项的name属性与moduleId相同，就将main属性拼接在moduleId之后
    each(packagesIndex, function(packageConf) {
        var name = packageConf.name;
        if (name === moduleId) {
          moduleId = name + '/' + packageConf.main;
          return false;
        }
      }
    );

    // mappingIdIndex=[{reg1:xx,k1:xx,v1:{reg2:xx,k2:xx,v2:xx}}]，reg1匹配baseId，reg2匹配moduleId,将moduleId中的k2用v2替换
    indexRetrieve(baseId, mappingIdIndex, function(value) {
        indexRetrieve(moduleId, value, function(mdValue, mdKey) {
            moduleId = moduleId.replace(mdKey, mdValue);
          }
        );
     });

    //对resourceId也进行一次normalize的处理
    if (resourceId) {
      var module = modGetModuleExports(moduleId);
      resourceId = module.normalize ? module.normalize(resourceId, function(resId) {return normalize(resId, baseId);}) : normalize(resourceId, baseId);
      moduleId += '!' + resourceId;
    }

    return moduleId;
  }

  ////把模块中的..和.删掉
  function relative2absolute(id, baseId) {
    if (id.indexOf('.') === 0) {
      var basePath = baseId.split('/');
      var namePath = id.split('/');
      var baseLen = basePath.length - 1;
      var nameLen = namePath.length;
      var cutBaseTerms = 0;
      var cutNameTerms = 0;

      pathLoop: for (var i = 0; i < nameLen; i++) {
        var term = namePath[i];
        switch (term) {
          case '..':
            if (cutBaseTerms < baseLen) {
              cutBaseTerms++;
              cutNameTerms++;
            } else {
              break pathLoop;
            }
            break;
          case '.':
            cutNameTerms++;
            break;
          default:
            break pathLoop;
        }
      }

      basePath.length = baseLen - cutBaseTerms;
      namePath = namePath.slice(cutNameTerms);

      return basePath.concat(namePath).join('/'); //合并路径
    }

    return id;
  }

  //将id以！分割
  function parseId(id) {
    var segs = id.split('!'); //依赖的模块路径里面有可能有感叹号，
    //模块只能由/-_a-z0-9.构成
    if (/^[-_a-z0-9\.]+(\/[-_a-z0-9\.]+)*$/i.test(segs[0])) {
      return {
        module: segs[0], //感叹号之前的路径
        resource: segs[1] //感叹号之后的路径
      };
    }

    return null;
  }

  //创建对象数组 每个对象包括source的key、value以及value对应的正则表达式
  function kv2List(source, keyMatchable, allowAsterisk) {
    var list = [];
    for (var key in source) {
      if (source.hasOwnProperty(key)) {
        var item = {
          k: key,
          v: source[key]
        };
        list.push(item);

        if (keyMatchable) {
          item.reg = key === '*' && allowAsterisk ? /^/ : createPrefixRegexp(key);
        }
      }
    }

    return list;
  }

  var currentlyAddingScript;
  var interactiveScript;

  function getCurrentScript() {
    if (currentlyAddingScript) {
      return currentlyAddingScript;
    } else if (interactiveScript && interactiveScript.readyState === 'interactive') {
      return interactiveScript;
    } else {
      var scripts = document.getElementsByTagName('script');
      var scriptLen = scripts.length;
      while (scriptLen--) {
        var script = scripts[scriptLen];
        if (script.readyState === 'interactive') {
          interactiveScript = script;
          return script;
        }
      }
    }
  }

  var headElement = document.getElementsByTagName('head')[0];
  var baseElement = document.getElementsByTagName('base')[0];
  if (baseElement) {
    headElement = baseElement.parentNode;
  }

  //将script元素插入head中
  function appendScript(script) {
    currentlyAddingScript = script;

    // If BASE tag is in play, using appendChild is a problem for IE6.
    // See: http://dev.jquery.com/ticket/2709
    baseElement ? headElement.insertBefore(script, baseElement) : headElement.appendChild(script);

    currentlyAddingScript = null;
  }

  //创建正则表达式
  function createPrefixRegexp(prefix) {
    return new RegExp('^' + prefix + '(/|$)');
  }

  //将source中的每一项放在iterator中执行一遍，如果结果是false遍历结束
  function each(source, iterator) {
    if (source instanceof Array) {
      for (var i = 0, len = source.length; i < len; i++) {
        if (iterator(source[i], i) === false) {
          break;
        }
      }
    }
  }

  //按照参数的k或name属性来排序，*排在右边
  function descSorterByKOrName(a, b) {
    var aValue = a.k || a.name;
    var bValue = b.k || b.name;

    if (bValue === '*') {
      return -1;
    }

    if (aValue === '*') {
      return 1;
    }

    return bValue.length - aValue.length;
  }

  // 暴露全局对象
  global.define = define;
  global.require = require;

})(this)
