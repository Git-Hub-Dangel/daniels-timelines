const { Plugin } = require('obsidian');

// Base cyclical color palette for groups
const PALETTE = [
  "#f4a5a5",
  "#a5d8dd",  
  "#ffb88c",  
  "#b5e7a0", 
  "#f8b5d0",  
  "#d5b3ff",
  "#c1e1c5", 
];

const ROW_HEIGHT = 36;

module.exports = class TimelinesPlugin extends Plugin {
  async onload() {
    this.activeCodeBlocks = new Map();
    this.debounceTimers = new Map();

    this.registerMarkdownCodeBlockProcessor("timeline", (source, el, ctx) => {
      this.renderTimeline(source, el, ctx);
    });

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        this.handleMetadataChange(file);
      })
    );

    this.addCommand({
      id: 'insert-timeline',
      name: 'Insert timeline',
      editorCallback: (editor) => {
        const template = `\`\`\`timeline
source: "path/to/folder"
timespan: "m"
startTimeProperty: "start-date"
endTimeProperty: "end-date"
includeWeekend: true
groupProperty: ""
groupColors: {}
groupDisplay: true
checkboxProperty: ""
showMarker: true
viewMarkerOffset: 20
wrapTitles: false
\`\`\``;
        editor.replaceSelection(template);
      }
    });
  }

  onunload() {
    this.activeCodeBlocks.clear();
    this.debounceTimers.forEach(timer => clearTimeout(timer));
    this.debounceTimers.clear();
  }

  handleMetadataChange(file) {
    const path = file.path;
    if (this.debounceTimers.has(path)) {
      clearTimeout(this.debounceTimers.get(path));
    }

    this.debounceTimers.set(path, setTimeout(() => {
      this.activeCodeBlocks.forEach((data, el) => {
        if (data.sourceFiles && data.sourceFiles.includes(file)) {
          this.renderTimeline(data.source, el, data.ctx);
        }
      });
      this.debounceTimers.delete(path);
    }, 500));
  }

  renderTimeline(source, el, ctx) {
    el.empty();

    const config = this.parseProperties(source);

    if (!config.source || !config.timespan || !config.startTimeProperty || !config.endTimeProperty) {
      this.renderError(el, config, "Missing required properties: source, timespan, startTimeProperty, endTimeProperty");
      return;
    }

    const filesResult = this.resolveSourceFiles(config.source);
    if (filesResult.error) {
      this.renderError(el, config, filesResult.error);
      return;
    }

    const extractResult = this.extractBlocks(filesResult.files, config);
    if (extractResult.blocks.length === 0) {
      this.renderError(el, config, "No notes found with valid date properties", extractResult.warnings);
      return;
    }

    const timeAxis = this.calculateTimeAxis(extractResult.blocks, config.timespan, config.includeWeekend);
    const groupedBlocks = this.groupAndSortBlocks(extractResult.blocks, config.groupProperty);
    this.packRows(groupedBlocks);
    const colorMap = this.resolveColors(groupedBlocks, config.groupColors, config.groupProperty);

    this.buildDOM(el, {
      config,
      blocks: extractResult.blocks,
      groupedBlocks,
      timeAxis,
      colorMap,
      warnings: extractResult.warnings,
      count: extractResult.blocks.length
    });

    this.activeCodeBlocks.set(el, {
      source,
      ctx,
      sourceFiles: filesResult.files
    });
  }

  parseProperties(source) {
    const config = {
      includeWeekend: true,
      groupProperty: null,
      groupColors: {},
      groupDisplay: false,
      checkboxProperty: null,
      showMarker: true,
      viewMarkerOffset: 20,
      wrapTitles: false
    };

    const lines = source.split('\n');
    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;

      const key = line.substring(0, colonIndex).trim();
      let value = line.substring(colonIndex + 1).trim();

      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.substring(1, value.length - 1);
      }

      if (key === 'includeWeekend' || key === 'groupDisplay' || key === 'showMarker' || key === 'wrapTitles') {
        config[key] = value.toLowerCase() === 'true';
      } else if (key === 'viewMarkerOffset') {
        const num = parseInt(value, 10);
        config[key] = isNaN(num) ? 20 : Math.max(0, Math.min(100, num));
      } else if (key === 'groupColors') {
        try {
          config[key] = JSON.parse(value);
        } catch (e) {
          console.warn('Timelines: Failed to parse groupColors, using defaults', e);
        }
      } else {
        config[key] = value;
      }
    }

    return config;
  }

  resolveSourceFiles(sourcePath) {
    const folder = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!folder) {
      return { error: `Folder not found: ${sourcePath}` };
    }

    const files = folder.children.filter(f => f.extension === 'md');
    return { files };
  }

  extractBlocks(files, config) {
    const blocks = [];
    const warnings = [];

    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const frontmatter = cache?.frontmatter;

      if (!frontmatter) {
        warnings.push(file.basename);
        continue;
      }

      const startDateRaw = frontmatter[config.startTimeProperty];
      const endDateRaw = frontmatter[config.endTimeProperty];

      if (!startDateRaw || !endDateRaw) {
        warnings.push(file.basename);
        continue;
      }

      let startDate = this.parseDate(startDateRaw);
      let endDate = this.parseDate(endDateRaw);

      if (!startDate || !endDate) {
        warnings.push(file.basename);
        continue;
      }

      if (startDate > endDate) {
        [startDate, endDate] = [endDate, startDate];
      }

      const block = {
        title: file.basename,
        startDate,
        endDate,
        group: config.groupProperty ? frontmatter[config.groupProperty] : null,
        checked: (config.checkboxProperty && config.checkboxProperty !== '') ? frontmatter[config.checkboxProperty] === true : undefined,
        file
      };

      blocks.push(block);
    }

    return { blocks, warnings };
  }

  parseDate(dateStr) {
    if (!dateStr) return null;
    const date = new Date(dateStr);
    return isNaN(date.getTime()) ? null : date;
  }

  calculateTimeAxis(blocks, timespanStr, includeWeekend) {
    let parsed = this.parseTimespan(timespanStr);
    if (!parsed) {
      console.warn('Timelines: Invalid timespan, falling back to 1m');
      parsed = { n: 1, unit: 'm' };
    }

    let globalMin = new Date(Math.min(...blocks.map(b => b.startDate.getTime())));
    let globalMax = new Date(Math.max(...blocks.map(b => b.endDate.getTime())));

    const { min, max } = this.extendToUnitBoundaries(globalMin, globalMax, parsed.unit);
    globalMin = this.addTimeUnit(min, parsed.unit, -1);
    globalMax = this.addTimeUnit(max, parsed.unit, 1);

    const pixelsPerDay = this.getPixelsPerDay(parsed.n, parsed.unit);
    const headerCells = this.generateHeaderCells(globalMin, globalMax, parsed.n, parsed.unit, includeWeekend);

    const shouldExcludeWeekends = includeWeekend === false && ['d', 'w'].includes(parsed.unit);

    const dateToX = (date) => {
      if (!shouldExcludeWeekends) {
        const diffMs = date.getTime() - globalMin.getTime();
        const diffDays = diffMs / (1000 * 60 * 60 * 24);
        return diffDays * pixelsPerDay;
      } else {
        return this.getWeekdayOffset(globalMin, date) * pixelsPerDay;
      }
    };

    return {
      globalMin,
      globalMax,
      pixelsPerDay,
      headerCells,
      dateToX,
      unit: parsed.unit,
      n: parsed.n,
      includeWeekend,
      shouldExcludeWeekends
    };
  }

  parseTimespan(str) {
    const match = str.match(/^(\d+)?([dwmy])$/);
    if (!match) return null;
    return {
      n: match[1] ? parseInt(match[1], 10) : 1,
      unit: match[2]
    };
  }

  extendToUnitBoundaries(min, max, unit) {
    const minBound = new Date(min);
    const maxBound = new Date(max);

    switch (unit) {
      case 'd':
        minBound.setHours(0, 0, 0, 0);
        maxBound.setDate(maxBound.getDate() + 1);
        maxBound.setHours(0, 0, 0, 0);
        break;
      case 'w':
        const dayOfWeek = minBound.getDay();
        const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
        minBound.setDate(minBound.getDate() + mondayOffset);
        minBound.setHours(0, 0, 0, 0);
        const maxDayOfWeek = maxBound.getDay();
        const sundayOffset = maxDayOfWeek === 0 ? 0 : 7 - maxDayOfWeek;
        maxBound.setDate(maxBound.getDate() + sundayOffset + 1);
        maxBound.setHours(0, 0, 0, 0);
        break;
      case 'm':
        minBound.setDate(1);
        minBound.setHours(0, 0, 0, 0);
        maxBound.setMonth(maxBound.getMonth() + 1, 1);
        maxBound.setHours(0, 0, 0, 0);
        break;
      case 'y':
        minBound.setMonth(0, 1);
        minBound.setHours(0, 0, 0, 0);
        maxBound.setFullYear(maxBound.getFullYear() + 1, 0, 1);
        maxBound.setHours(0, 0, 0, 0);
        break;
    }

    return { min: minBound, max: maxBound };
  }

  addTimeUnit(date, unit, amount) {
    const result = new Date(date);
    switch (unit) {
      case 'd':
        result.setDate(result.getDate() + amount);
        break;
      case 'w':
        result.setDate(result.getDate() + amount * 7);
        break;
      case 'm':
        result.setMonth(result.getMonth() + amount);
        break;
      case 'y':
        result.setFullYear(result.getFullYear() + amount);
        break;
    }
    return result;
  }

  getPixelsPerDay(n, unit) {
    const viewportWidth = 600;

    let daysPerUnit;
    switch(unit) {
      case 'd': daysPerUnit = 1; break;
      case 'w': daysPerUnit = 7; break;
      case 'm': daysPerUnit = 30; break;
      case 'y': daysPerUnit = 365; break;
      default: daysPerUnit = 30;
    }

    return viewportWidth / (n * daysPerUnit);
  }

  generateHeaderCells(min, max, n, unit, includeWeekend) {
    const cells = { primary: [], secondary: [] };
    const current = new Date(min);

    const shouldExcludeWeekends = includeWeekend === false && ['d', 'w'].includes(unit);

    while (current < max) {
      const next = this.addTimeUnit(current, unit, 1);
      const actualNext = next > max ? max : next;

      let width;
      if (shouldExcludeWeekends) {
        width = this.getWeekdayOffset(current, actualNext) * this.getPixelsPerDay(n, unit);
      } else {
        const diffMs = actualNext.getTime() - current.getTime();
        const diffDays = diffMs / (1000 * 60 * 60 * 24);
        width = diffDays * this.getPixelsPerDay(n, unit);
      }

      cells.primary.push({
        label: this.formatPrimaryHeader(current, unit, 1),
        width,
        date: new Date(current)
      });

      if (unit === 'd' || (unit === 'w' && n === 1)) {
        const iterDate = new Date(current);
        const endDate = new Date(actualNext);
        while (iterDate < endDate) {
          const dayOfWeek = iterDate.getDay();
          const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

          if (!shouldExcludeWeekends || !isWeekend) {
            const nextDay = new Date(iterDate);
            nextDay.setDate(nextDay.getDate() + 1);
            const dayWidth = shouldExcludeWeekends && isWeekend ? 0 :
              (nextDay.getTime() - iterDate.getTime()) / (1000 * 60 * 60 * 24) * this.getPixelsPerDay(n, unit);

            if (dayWidth > 0) {
              cells.secondary.push({
                label: unit === 'w' ? this.formatWeekDay(iterDate) : String(iterDate.getDate()),
                width: dayWidth,
                date: new Date(iterDate)
              });
            }
          }
          iterDate.setDate(iterDate.getDate() + 1);
        }
      } else if (unit === 'm') {
        cells.secondary.push({
          label: String(current.getFullYear()),
          width,
          date: new Date(current)
        });
      } else if (unit === 'y') {
        for (let m = 0; m < 12; m++) {
          const monthDate = new Date(current.getFullYear(), m, 1);
          if (monthDate >= current && monthDate < actualNext) {
            const nextMonth = new Date(current.getFullYear(), m + 1, 1);
            const monthEnd = nextMonth > actualNext ? actualNext : nextMonth;
            const monthWidth = (monthEnd.getTime() - monthDate.getTime()) / (1000 * 60 * 60 * 24) * this.getPixelsPerDay(n, unit);
            cells.secondary.push({
              label: monthDate.toLocaleDateString('en', { month: 'short' }),
              width: monthWidth,
              date: monthDate
            });
          }
        }
      }

      current.setTime(next.getTime());
    }

    return cells;
  }

  formatPrimaryHeader(date, unit, n) {
    switch (unit) {
      case 'd':
        return date.toLocaleDateString('en', { weekday: n === 1 ? 'long' : 'short' });
      case 'w':
        return 'W' + this.getWeekNumber(date);
      case 'm':
        return date.toLocaleDateString('en', { month: 'short' });
      case 'y':
        return String(date.getFullYear());
      default:
        return '';
    }
  }

  formatWeekDay(date) {
    return date.toLocaleDateString('en', { weekday: 'long' });
  }

  getWeekNumber(date) {
    const tempDate = new Date(date.getTime());
    tempDate.setHours(0, 0, 0, 0);
    tempDate.setDate(tempDate.getDate() + 3 - (tempDate.getDay() + 6) % 7);
    const week1 = new Date(tempDate.getFullYear(), 0, 4);
    return 1 + Math.round(((tempDate - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
  }

  getWeekdayOffset(startDate, endDate) {
    let count = 0;
    const current = new Date(startDate);
    while (current < endDate) {
      const dayOfWeek = current.getDay();
      if (dayOfWeek !== 0 && dayOfWeek !== 6) {
        count++;
      }
      current.setDate(current.getDate() + 1);
    }
    return count;
  }

  groupAndSortBlocks(blocks, groupProperty) {
    const grouped = new Map();
    const ungrouped = [];

    for (const block of blocks) {
      if (groupProperty && block.group !== null && block.group !== undefined) {
        if (!grouped.has(block.group)) {
          grouped.set(block.group, []);
        }
        grouped.get(block.group).push(block);
      } else {
        ungrouped.push(block);
      }
    }

    grouped.forEach(blocks => {
      blocks.sort((a, b) => a.startDate - b.startDate);
    });

    if (ungrouped.length > 0) {
      ungrouped.sort((a, b) => a.startDate - b.startDate);
    }

    if (grouped.size === 0 && ungrouped.length > 0) {
      grouped.set(null, ungrouped);
    } else if (ungrouped.length > 0) {
      grouped.set(null, ungrouped);
    }

    return grouped;
  }

  packRows(groupedBlocks) {
    groupedBlocks.forEach((blocks, groupName) => {
      const lines = [];
      for (const block of blocks) {
        let placed = false;
        for (let i = 0; i < lines.length; i++) {
          if (block.startDate >= lines[i].lastEnd) {
            block.line = i;
            lines[i].lastEnd = block.endDate;
            placed = true;
            break;
          }
        }
        if (!placed) {
          block.line = lines.length;
          lines.push({ lastEnd: block.endDate });
        }
      }
      groupedBlocks.set(groupName, {
        blocks,
        lineCount: lines.length
      });
    });
  }

  resolveColors(groupedBlocks, groupColors, groupProperty) {
    const colorMap = new Map();
    let paletteIndex = 0;

    if (!groupProperty) {
      colorMap.set(null, PALETTE[0]);
      return colorMap;
    }

    groupedBlocks.forEach((data, groupName) => {
      if (groupName === null) {
        colorMap.set(null, 'var(--text-muted)');
      } else if (groupColors[groupName]) {
        colorMap.set(groupName, groupColors[groupName]);
      } else {
        colorMap.set(groupName, PALETTE[paletteIndex % PALETTE.length]);
        paletteIndex++;
      }
    });

    return colorMap;
  }

  buildDOM(el, data) {
    const container = el.createDiv({ cls: 'timelines-container' });

    let groupLabelsCol = null;
    if (data.config.groupDisplay && data.config.groupProperty) {
      groupLabelsCol = this.buildGroupLabels(container, data);
    }

    const scrollWrapper = container.createDiv({ cls: 'timelines-scroll-wrapper' });
    const header = this.buildHeader(scrollWrapper, data.timeAxis);
    const body = this.buildBody(scrollWrapper, data);
    this.buildStatus(body, data.count, data.warnings);

    if (groupLabelsCol && header) {
      setTimeout(() => {
        const headerHeight = header.offsetHeight;
        groupLabelsCol.style.paddingTop = `${headerHeight}px`;
      }, 0);
    }

    setTimeout(() => {
      this.scrollToMarker(scrollWrapper, data.timeAxis, data.config);
    }, 0);
  }

  buildGroupLabels(container, data) {
    const labelsCol = container.createDiv({ cls: 'timelines-group-labels' });

    data.groupedBlocks.forEach((groupData, groupName) => {
      const labelDiv = labelsCol.createDiv({ cls: 'timelines-group-label' });
      labelDiv.style.height = `${groupData.lineCount * ROW_HEIGHT}px`;
      labelDiv.textContent = groupName === null ? 'Ungrouped' : groupName;
    });

    return labelsCol;
  }

  buildHeader(scrollWrapper, timeAxis) {
    const header = scrollWrapper.createDiv({ cls: 'timelines-header' });

    const primaryRow = header.createDiv({ cls: 'timelines-header-primary' });
    let totalWidth = 0;
    timeAxis.headerCells.primary.forEach(cell => {
      const cellEl = primaryRow.createDiv({ cls: 'timelines-header-cell' });
      cellEl.style.width = `${cell.width}px`;
      cellEl.textContent = cell.label;
      totalWidth += cell.width;
    });
    primaryRow.style.minWidth = `${totalWidth}px`;

    if (timeAxis.headerCells.secondary.length > 0) {
      const secondaryRow = header.createDiv({ cls: 'timelines-header-secondary' });
      timeAxis.headerCells.secondary.forEach(cell => {
        const cellEl = secondaryRow.createDiv({ cls: 'timelines-header-cell' });
        cellEl.style.width = `${cell.width}px`;
        cellEl.textContent = cell.label;
      });
      secondaryRow.style.minWidth = `${totalWidth}px`;
    }

    header.style.minWidth = `${totalWidth}px`;

    return header;
  }

  buildBody(scrollWrapper, data) {
    const body = scrollWrapper.createDiv({ cls: 'timelines-body' });

    const totalWidth = data.timeAxis.headerCells.primary.reduce((sum, cell) => sum + cell.width, 0);
    body.style.minWidth = `${totalWidth}px`;

    this.buildGridlines(body, data.timeAxis, totalWidth);

    if (data.config.showMarker) {
      this.buildTodayMarker(body, data.timeAxis);
    }

    let offsetY = 0;
    data.groupedBlocks.forEach((groupData, groupName) => {
      const section = body.createDiv({ cls: 'timelines-group-section' });
      section.style.height = `${groupData.lineCount * ROW_HEIGHT}px`;
      section.style.top = `${offsetY}px`;

      groupData.blocks.forEach(block => {
        this.buildBlock(section, block, data, offsetY);
      });

      offsetY += groupData.lineCount * ROW_HEIGHT;
    });

    body.style.height = `${offsetY}px`;
    body.style.minHeight = `${offsetY}px`;

    if (data.config.wrapTitles) {
      setTimeout(() => {
        this.adjustHeightsForWrappedTitles(body, data.groupedBlocks);
      }, 0);
    }

    return body;
  }

  adjustHeightsForWrappedTitles(body, groupedBlocks) {
    const sections = body.querySelectorAll('.timelines-group-section');
    let cumulativeHeight = 0;

    sections.forEach((section, index) => {
      const blocks = section.querySelectorAll('.timelines-block');
      let maxBottom = 0;

      blocks.forEach(block => {
        const top = parseFloat(block.style.top);
        const height = block.offsetHeight;
        const bottom = top + height;
        if (bottom > maxBottom) {
          maxBottom = bottom;
        }
      });

      const actualHeight = Math.max(maxBottom + 8, parseFloat(section.style.height));
      section.style.height = `${actualHeight}px`;
      section.style.top = `${cumulativeHeight}px`;
      cumulativeHeight += actualHeight;
    });

    body.style.height = `${cumulativeHeight}px`;
    body.style.minHeight = `${cumulativeHeight}px`;
  }

  buildGridlines(body, timeAxis, totalWidth) {
    const gridlinesContainer = body.createDiv({ cls: 'timelines-gridlines' });
    let x = 0;
    timeAxis.headerCells.primary.forEach((cell, idx) => {
      if (idx > 0) {
        const line = gridlinesContainer.createDiv({ cls: 'timelines-gridline' });
        line.style.left = `${x}px`;
      }
      x += cell.width;
    });
  }

  buildTodayMarker(body, timeAxis) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (today >= timeAxis.globalMin && today <= timeAxis.globalMax) {
      const todayX = timeAxis.dateToX(today);
      const marker = body.createDiv({ cls: 'timelines-marker' });
      marker.style.left = `${todayX}px`;

      const label = marker.createDiv({ cls: 'timelines-marker-label' });
      label.textContent = `Today (${today.getFullYear()})`;
    }
  }

  buildBlock(section, block, data, sectionOffsetY) {
    const startX = data.timeAxis.dateToX(block.startDate);
    const endX = data.timeAxis.dateToX(block.endDate);
    const width = Math.max(20, endX - startX);

    const blockEl = section.createDiv({ cls: 'timelines-block' });
    blockEl.style.left = `${startX}px`;
    blockEl.style.width = `${width}px`;
    blockEl.style.top = `${block.line * ROW_HEIGHT + 4}px`;

    const color = data.colorMap.get(block.group);
    blockEl.style.backgroundColor = color;

    if (data.config.wrapTitles) {
      blockEl.addClass('timelines-block--wrap');
    }

    if (data.config.checkboxProperty && data.config.checkboxProperty !== '' && block.checked !== undefined) {
      const checkbox = blockEl.createEl('input', {
        cls: 'timelines-block-checkbox',
        type: 'checkbox'
      });
      checkbox.checked = block.checked;
      checkbox.addEventListener('click', (evt) => {
        evt.stopPropagation();
      });
      checkbox.addEventListener('change', (evt) => {
        evt.stopPropagation();
        this.handleCheckboxToggle(block, checkbox.checked, data.config.checkboxProperty);
        if (checkbox.checked) {
          blockEl.addClass('timelines-block--done');
        } else {
          blockEl.removeClass('timelines-block--done');
        }
      });
      if (block.checked) {
        blockEl.addClass('timelines-block--done');
      }
    }

    const titleSpan = blockEl.createSpan({ cls: 'timelines-block-title' });
    titleSpan.textContent = block.title;
    titleSpan.style.cursor = 'pointer';

    titleSpan.addEventListener('click', (evt) => {
      evt.preventDefault();
      this.app.workspace.openLinkText(block.file.path, '', false);
    });

    blockEl.addEventListener('mouseenter', (evt) => {
      if (evt.metaKey || evt.ctrlKey) {
        this.app.workspace.trigger('hover-link', {
          event: evt,
          source: 'timelines',
          hoverParent: blockEl,
          targetEl: blockEl,
          linktext: block.file.path,
          sourcePath: ''
        });
      }
    });
  }

  handleCheckboxToggle(block, newValue, checkboxProperty) {
    const file = block.file;
    this.app.vault.process(file, (content) => {
      const lines = content.split('\n');
      let inFrontmatter = false;
      let fmStart = -1;
      let fmEnd = -1;

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === '---') {
          if (!inFrontmatter) {
            inFrontmatter = true;
            fmStart = i;
          } else {
            fmEnd = i;
            break;
          }
        }
      }

      if (fmStart !== -1 && fmEnd !== -1) {
        let propertyFound = false;
        for (let i = fmStart + 1; i < fmEnd; i++) {
          const line = lines[i];
          const colonIdx = line.indexOf(':');
          if (colonIdx !== -1) {
            const key = line.substring(0, colonIdx).trim();
            if (key === checkboxProperty) {
              lines[i] = `${key}: ${newValue}`;
              propertyFound = true;
              break;
            }
          }
        }

        if (!propertyFound) {
          lines.splice(fmEnd, 0, `${checkboxProperty}: ${newValue}`);
        }
      }

      return lines.join('\n');
    });

    block.checked = newValue;
  }

  buildStatus(body, count, warnings) {
    const status = body.createDiv({ cls: 'timelines-status' });

    const countEl = status.createDiv({ cls: 'timelines-status-count' });
    countEl.textContent = `${count} note${count !== 1 ? 's' : ''} displayed`;

    if (warnings.length > 0) {
      const warningEl = status.createDiv({ cls: 'timelines-status-warning' });
      warningEl.textContent = `${warnings.length} file${warnings.length !== 1 ? 's' : ''} missing date properties`;
    }
  }

  scrollToMarker(scrollWrapper, timeAxis, config) {
    if (!config.showMarker) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (today >= timeAxis.globalMin && today <= timeAxis.globalMax) {
      const todayX = timeAxis.dateToX(today);
      const viewportWidth = scrollWrapper.clientWidth;
      const scrollTarget = todayX - (viewportWidth * config.viewMarkerOffset / 100);
      scrollWrapper.scrollLeft = Math.max(0, scrollTarget);
    }
  }

  renderError(el, config, errorMsg, warnings = []) {
    const container = el.createDiv({ cls: 'timelines-container' });
    const scrollWrapper = container.createDiv({ cls: 'timelines-scroll-wrapper' });

    const header = scrollWrapper.createDiv({ cls: 'timelines-header' });
    const primaryRow = header.createDiv({ cls: 'timelines-header-primary' });
    primaryRow.textContent = 'Timeline';

    const body = scrollWrapper.createDiv({ cls: 'timelines-body' });
    body.style.minHeight = '100px';

    const status = body.createDiv({ cls: 'timelines-status' });
    const errorEl = status.createDiv({ cls: 'timelines-status-error' });
    errorEl.textContent = errorMsg;

    if (warnings.length > 0) {
      const warningEl = status.createDiv({ cls: 'timelines-status-warning' });
      warningEl.textContent = `${warnings.length} file${warnings.length !== 1 ? 's' : ''} missing date properties`;
    }
  }
};
