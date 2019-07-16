'use strict';


import { div, button, iconButton, h4 } from './tags.js'
import {
    BoolType,
    ByteType,
    DateType, DoubleType,
    FloatType,
    IntType,
    LongType,
    ShortType,
    StringType,
    TimestampType
} from "./data_type";
import {FakeSelect} from "./fake_select";
import {fakeSelectElem, span, textbox} from "./tags";
import {SocketSession} from "./comms";
import {CellMetadata, GroupAgg, ModifyStream, ReleaseHandle} from "./messages";
import {Pair} from "./codec";
import {DataStream, StreamingDataRepr} from "./value_repr";
import embed from "vega-embed";
import {UIEventTarget} from "./ui_event";
import {CodeCell} from "./cell";
import {ToolbarEvent} from "./toolbar";
import {VegaClientResult} from "./vega_interpreter";
import {ClientResult} from "./result";


function isDimension(dataType) {
    return (
        dataType === ByteType ||
        dataType === BoolType ||
        dataType === ShortType ||
        dataType === IntType ||
        dataType === LongType ||
        dataType === StringType ||
        dataType === DateType ||
        dataType === TimestampType
    )
}

function measures(field) {
    const dataType = field.dataType;
    if (
        dataType === ByteType ||
        dataType === ShortType ||
        dataType === IntType ||
        dataType === LongType ||
        dataType === FloatType ||
        dataType === DoubleType
    ) {
        const selector = new FakeSelect(fakeSelectElem(['choose-measure'], [
            button(['selected'], {value: 'mean'}, ['Mean']),
            button([], {value: 'count'}, ['Count']),
            button([], {value: 'quartiles'}, ['Quartiles'])
        ]));

        return div(['measure', 'selected-measure'], [
            div(['choose-measure'], [
                selector.element
            ]),
            span(['measure-name'], field.name)
        ]).attr('draggable', true).withKey('field', field).withKey('selector', selector);
    } else return false;
}

function dimensionType(dataType) {
    if (dataType === StringType || dataType === BoolType) return 'nominal';
    if (dataType === DoubleType) return 'quantitative';
    return 'ordinal';
}

export class PlotEditor extends UIEventTarget {

    constructor(repr, path, name, sourceCell) {
        super();
        this.repr = repr;
        this.path = path;
        this.name = name;
        this.sourceCell = sourceCell;
        this.fields = repr.dataType.fields;

        this.plotTypeSelector = new FakeSelect(fakeSelectElem(['plot-type-selector'], [
            button(['selected'], {value: 'bar'}, ['Bar']),
            button([], {value: 'line'}, ['Line']),
            button([], {value: 'xy'}, ['XY Scatter']),
            button([], {value: 'boxplot'}, ['Box Plot'])
        ]));

        this.specType = normalSpec;

        this.el = div(['plot-editor'], [
            this.controls = div(['left-controls'], [
                h4(['plot-type-title'], ['Plot type']),
                this.plotTypeSelector.element,
                h4(['plot-size-title'], ['Size']),
                div(['plot-size'], [
                    this.plotWidthInput = textbox(['plot-width'], 'Width', 960).attr("maxlength", "4").change(evt => this.plotOutput.style.width = parseInt(evt.target.value, 10) + 'px'),
                    span([],'⨉'),
                    this.plotHeightInput = textbox(['plot-height'], 'Height', 480).change(evt => this.plotOutput.style.height = parseInt(evt.target.value, 10) + 'px')
                ]),
                h4(['dimension-title'], ['Dimensions', iconButton(['add', 'add-measure'], 'Add dimension', '', 'Add').click(_ => this.showAddDimension())]),
                div(['dimension-list'], this.listDimensions()),
                h4(['measure-title'], ['Measures', iconButton(['add', 'add-measure'], 'Add measure', '', 'Add').click(_ => this.showAddMeasure())]),
                div(['measure-list'], this.listMeasures()),
                h4(['numeric-field-title'], ['Fields']),
                div(['numeric-field-list'], this.listNumerics()),
                div(['control-buttons'], [
                    this.saveButton = button(['save'], {}, [
                        span(['fas'], ''),
                        'Save'
                    ]).click(_ => this.savePlot()),
                    this.runButton = button(['plot'], {}, [
                        span(['fas'], ''),
                        'Plot'
                    ]).click(_ => this.runPlot())
                ])
            ]),
            this.plotArea = div(['plot-area'], [
                this.plotOutput = div(['plot-output'], [
                    div(['plot-title'], [
                       this.plotTitle = textbox([], 'Plot title', '')
                    ]),
                    this.xAxisDrop = div(['x-axis-drop'], [span(['label'], [
                        this.xTitle = textbox([], 'Enter an axis title', ''),
                        span(['placeholder'], ['Drop X-axis dimension here'])
                    ])]),
                    this.yAxisDrop = div(['y-axis-drop'], [span(['label'], [
                        span(['placeholder'], ['Drop Y-axis measure(s) here']),
                        this.yTitle = textbox([], 'Enter an axis title', '')
                    ])]),
                    div(['plot-embed'], [])
                ])
            ])
        ]);

        this.saveButton.style.display = 'none';

        this.plotOutput.style.width = '960px';
        this.plotOutput.style.height = '480px';

        this.plotTypeSelector.addEventListener('change', evt => this.onPlotTypeChange(evt));

        this.el.addEventListener('dragstart', evt => {
           this.draggingEl = evt.target;
        });

        this.addEventListener('dragend', evt => {
           this.xAxisDrop.classList.remove('drop-ok', 'drop-disallowed');
           this.yAxisDrop.classList.remove('drop-ok', 'drop-disallowed');
           this.draggingEl = null;
        });

        this.xAxisDrop.addEventListener('dragenter', evt => {
           if (this.draggingEl.classList.contains(this.correctXType)) {
               this.xAxisDrop.classList.add('drop-ok');
           } else {
               this.xAxisDrop.classList.add('drop-disallowed');
           }
        });

        this.xAxisDrop.addEventListener('dragover', evt => {
            if (this.draggingEl.classList.contains(this.correctXType)) {
                evt.preventDefault();
            }
        });

        this.xAxisDrop.addEventListener('dragleave', _ => {
           this.xAxisDrop.classList.remove('drop-ok', 'drop-disallowed');
        });

        this.xAxisDrop.addEventListener('drop', evt => {
            this.setXField(this.draggingEl.field);
            this.xAxisDrop.classList.remove('drop-ok', 'drop-disallowed');
        });

        this.yAxisDrop.addEventListener('dragenter', evt => {
            if (this.draggingEl.classList.contains(this.correctYType)) {
                this.yAxisDrop.classList.add('drop-ok');
            } else {
                this.yAxisDrop.classList.add('drop-disallowed');
            }
        });

        this.yAxisDrop.addEventListener('dragover', evt => {
            if (this.draggingEl.classList.contains(this.correctYType)) {
                evt.preventDefault();
            }
        });

        this.yAxisDrop.addEventListener('dragleave', _ => {
            this.yAxisDrop.classList.remove('drop-ok', 'drop-disallowed');
        });

        this.yAxisDrop.addEventListener('drop', evt => {
           this.addYField(this.draggingEl);
           this.yAxisDrop.classList.remove('drop-ok', 'drop-disallowed');
        });

        this.session = SocketSession.current;

        this.onPlotTypeChange();
    }

    get correctYType() {
        if (this.rawFields) return 'numeric';
        return 'measure';
    }

    get correctXType() {
        if (this.rawFields) return 'numeric';
        return 'dimension';
    }

    showAddMeasure() {
        // TODO - show a UI to let you explore measures you can use in more detail
    }

    showAddDimension() {
        // TODO - show a UI to let you
    }

    listDimensions() {
        return this.fields.filter(field => isDimension(field.dataType)).map(
            field => div(['dimension'], [
                field.name,
                ` (${field.dataType.constructor.name(field.dataType)})`]
            ).withKey('field', field).attr('draggable', true)
        )
    }

    listNumerics() {
        return this.fields.filter(field => field.dataType.isNumeric).map(
            field => div(['numeric'], [
                field.name,
                ` (${field.dataType.constructor.name(field.dataType)})`]
            ).withKey('field', field).attr('draggable', true)
        )
    }

    listMeasures() {
        this.measureSelectors = this.fields.map(field => measures(field)).filter(_ => _);
        return this.measureSelectors;
    }

    onPlotTypeChange(evt) {
        function showDefaultMeasures(selector) {
            selector.showAllOptions();
            selector.hideOption('quartiles');
        }

        this.measureSelectors.forEach(el => delete el.style.display);
        this.controls.classList.remove('numeric-fields');
        this.rawFields = false;

        const plotType = this.plotTypeSelector.value;
        if (specialSpecs[plotType]) {
            const specType = specialSpecs[plotType];
            this.specType = specType;

            if (specType.rawFields) {
                this.controls.classList.add('numeric-fields');
                this.rawFields = true;
            } else if (specType.allowedAggregates) {
                this.measureSelectors.forEach(el => {
                    delete el.style.display;
                    const sel = el.selector;
                    sel.options.forEach((opt, idx) => {
                        if (specType.allowedAggregates.indexOf(opt.value) < 0) {
                            sel.hideOption(idx);
                        } else {
                            sel.showOption(idx);
                        }
                    });
                })
            } else if (!specType.allAggregates) {
                this.measureSelectors.forEach(el => showDefaultMeasures(el.selector));
            } else {
                this.measureSelectors.forEach(el => el.selector.showAllOptions());
            }
        } else {
            this.measureSelectors.forEach(el => showDefaultMeasures(el.selector));
        }
        // TODO - evict any measures that aren't allowed by this plot type
        // TODO - allow dimension vs dimension plot if the plot type allows it
    }

    getTableOps() {
        // TODO - for multiple mods, use diff from last mod
        const ops = [];
        if (this.rawFields) {
            return ops;
        }

        if (this.xDimension && this.yMeasures && this.yMeasures.length) {
            ops.push(
                new GroupAgg(
                    [this.xDimension.name],
                    this.yMeasures.map(meas => new Pair(meas.field.name, meas.agg))
                )
            );
        }

        return ops;
    }

    setXField(field) {
        this.xDimension = field;
        this.xAxisDrop.classList.add('nonempty');
        const label = this.xAxisDrop.querySelector('.label');
        [...label.querySelectorAll('.numeric, .dimension')].forEach(node => node.parentNode.removeChild(node));
        label.appendChild(span([this.correctXType], [field.name]));
    }

    addYField(from) {
        if (!this.yMeasures) {
            this.yMeasures = [];
        }

        if (this.rawFields) {
            this.yAxisDrop.classList.add('nonempty');
            this.yAxisDrop.appendChild(span([this.correctYType], [from.field.name]));
            this.yMeasures.push({
                field: from.field
            });

        } else if (from.classList.contains('selected-measure')) {
            const selector = from.selector;
            const field = from.field;
            const measureConfig = {
                field,
                agg: selector.value
            };

            this.yMeasures.push(measureConfig);

            const label = span(
                ['measure'], [
                    `${selector.value}(${field.name})`,
                    iconButton(['remove'], 'Remove', '', 'X').click(_ => {
                        const idx = this.yMeasures.indexOf(measureConfig);
                        this.yMeasures.splice(idx, 1);
                        label.parentNode.removeChild(label);
                        if (!this.yMeasures.length) {
                            this.yAxisDrop.classList.remove('nonempty');
                        }
                    })
                ]
            );

            this.yAxisDrop.classList.add('nonempty');
            const target = this.yAxisDrop.querySelector('.label');
            target.insertBefore(label, target.querySelector('input'));
        }
    }

    getSpec(plotType) {
        if(specialSpecs[plotType]) {
            const specFn = specialSpecs[plotType];
            let measures = this.yMeasures;
            if (specFn.allowedAggregates) {
                measures = measures.filter(measure => specFn.allowedAggregates.indexOf(measure.agg) >= 0);
            }
            if (!measures.length) {
                throw `No usable measures for ${plotType}`;
            }
            if (specFn.singleMeasure) {
                measures = measures[0]
            }
            return specFn.call(this, plotType, this.xDimension, measures);
        } else {
            return normalSpec.call(this, plotType, this.xDimension, this.yMeasures);
        }
    }

    runPlot() {
        //this.runButton.disabled = true;
        this.runButton.disabled = true;
        this.saveButton.style.display = 'none';
        const stream = new DataStream(this.path, this.repr, this.session, this.getTableOps()).batch(500);

        // TODO: multiple Ys
        // TODO: encode color
        // TODO: box plot has to be specially handled in order to pre-aggregate, https://github.com/vega/vega-lite/issues/4343
        const plotType = this.plotTypeSelector.value;

        const spec = this.getSpec(plotType);

        if (this.plotTitle.value !== '') {
            spec.title = this.plotTitle.value;
        }

        spec.autosize = 'fit';
        spec.width = +(this.plotWidthInput.value);
        spec.height = +(this.plotHeightInput.value);

        this.spec = spec;

        embed(
            this.plotOutput.querySelector('.plot-embed'),
            spec
        ).then(plot => {
            stream
                .to(batch => plot.view.insert(this.name, batch).runAsync())
                .run()
                .then(_ => {
                    plot.view.resize().runAsync();
                    this.saveButton.style.display = '';
                    this.plotOutput.style.width = this.plotOutput.querySelector('.plot-embed').offsetWidth + "px";
                    this.plotOutput.style.height = this.plotOutput.querySelector('.plot-embed').offsetHeight + "px";
                    this.runButton.disabled = false;
                    this.plot = plot;
                    //this.session.send(new ReleaseHandle(this.path, StreamingDataRepr.handleTypeId, repr.handle));
                });
        });
    }

    savePlot() {
        const spec = this.spec;
        this.spec.data.values = '$DATA_STREAM$';
        let content = JSON.stringify(this.spec, null, 2);
        const ops = this.getTableOps();
        let streamSpec = this.name;
        ops.forEach(op => {
            if (op instanceof GroupAgg) {
                const aggSpecs = op.aggregations.map(pair => {
                    const obj = {};
                    obj[pair.first] = pair.second;
                    return obj;
                });
                streamSpec = `${streamSpec}.aggregate(${JSON.stringify(op.columns)}, ${JSON.stringify(aggSpecs)})`;
            } // others TODO
        });
        content = content.replace('"$DATA_STREAM$"', streamSpec);
        const mkCell = cellId => new CodeCell(cellId, `(${content})`, 'vega', this.path, new CellMetadata(false, true, false, null));
        VegaClientResult.plotToOutput(this.plot).then(output => {
            const event = new ToolbarEvent('InsertCellAfter', {
                mkCell,
                cellId: this.sourceCell,
                results: [output],
                afterInsert: cell => cell.addResult(new PlotEditorResult(this.plotOutput.querySelector('.plot-embed'), output))
            });
            this.dispatchEvent(event);
        });
    }

}

function normalSpec(plotType, xField, yMeas) {
    const spec = {
        $schema: 'https://vega.github.io/schema/vega-lite/v3.json',
        data: {name: this.name},
        mark: plotType,
        encoding: {
            x: {
                field: xField.name,
                type: dimensionType(xField.dataType)
            }
        },
        width: this.plotOutput.offsetWidth - 100,
        height: this.plotOutput.offsetHeight - 100
    };

    if (yMeas instanceof Array && yMeas.length === 1) {
        yMeas = yMeas[0];
    }

    if (yMeas instanceof Array) {
        spec.transform = [{
            fold: yMeas.map(measure => measure.agg ? `${measure.agg}(${measure.field.name})` : measure.field.name)
        }];
        spec.encoding.y = {
            field: 'value'
        };
        spec.encoding.color = {
            field: 'key',
            type: 'nominal'
        };
    } else {
        spec.encoding.y = {
            field: yMeas.agg ? `${yMeas.agg}(${yMeas.field.name})` : yMeas.field.name,
            type: 'quantitative'
        };
    }

    if (this.yTitle.value !== '') {
        spec.encoding.y.axis = { title: this.yTitle.value }
    }

    if (this.xTitle.value !== '') {
        spec.encoding.x.axis = { title: this.xTitle.value }
    }

    return spec;
}

const specialSpecs = {
    boxplot: boxplotSpec,
    line: lineSpec,
    xy: xySpec
};

function xySpec(plotType, xField, yMeas) {
    return normalSpec.call(this, 'point', xField, yMeas);
}

xySpec.rawFields = true;
xySpec.singleMeasure = true;
xySpec.noAggregates = true;

// we kind of have to roll our own boxplot layering, because we are pre-aggregating the data (see https://github.com/vega/vega-lite/issues/4343)
// The way to construct it was taken from https://vega.github.io/vega-lite/docs/boxplot.html
// it's essentially what an actual box plot expands to.
function boxplotSpec(plotType, xField, yMeas) {
    // TODO: can we allow multiple series of boxes? Does `fold` support a struct like this?
    const yName = `quartiles(${yMeas.field.name})`;
    const yTitle = this.yTitle.value || yName;
    const x = { field: xField.name, type: dimensionType(xField.dataType) };
    if (this.xTitle.value) {
        x.axis = { title: this.xTitle.value }
    }
    const size = 14;
    return {
        $schema: 'https://vega.github.io/schema/vega-lite/v3.json',
        data: {name: this.name},
        width: this.plotOutput.offsetWidth - 100,
        height: this.plotOutput.offsetHeight - 100,
        layer: [
            {
                // lower whisker
                mark: {type: "rule", style: "boxplot-rule"},
                encoding: {
                    x,
                    y: {
                        field: `${yName}.min`,
                        type: 'quantitative',
                        axis: {title: yTitle}
                    },
                    y2: {
                        field: `${yName}.q1`
                    }
                }
            },
            {
                // upper whisker
                mark: {type: "rule", style: "boxplot-rule"},
                encoding: {
                    x,
                    y: {
                        field: `${yName}.q3`,
                        type: 'quantitative'
                    },
                    y2: {
                        field: `${yName}.max`
                    }
                }
            },
            {
                // box
                mark: {type: "bar", size, style: "boxplot-box"},
                encoding: {
                    x,
                    y: {
                        field: `${yName}.q1`,
                        type: 'quantitative'
                    },
                    y2: {
                        field: `${yName}.q3`
                    }
                }
            },
            {
                // median tick
                mark: {
                    color: 'white',
                    type: 'tick',
                    size,
                    orient: 'horizontal',
                    style: 'boxplot-median'
                },
                encoding: {
                    x,
                    y: {
                        field: `${yName}.median`,
                        type: 'quantitative'
                    }
                }
            },
            {
                // mean point
                mark: {
                    color: 'black',
                    type: 'point',
                    size: size / 2
                },
                encoding: {
                    x,
                    y: {
                        field: `${yName}.mean`,
                        type: 'quantitative'
                    }
                }
            }
        ]
    };
}

boxplotSpec.allowedAggregates = ['quartiles'];
boxplotSpec.singleMeasure = true;

function lineSpec(plotType, xField, yMeas) {
    if (yMeas instanceof Array && yMeas.length === 1) {
        yMeas = yMeas[0];
    }

    let yField = "";
    let transform = [];
    let encodeColor = false;
    let confidenceBands = false;
    let layer = [];

    if (yMeas instanceof Array) {
        transform = [{
            fold: yMeas.map(measure => `${measure.agg}(${measure.field.name})`)
        }];
        encodeColor = {
            field: 'key',
            type: 'nominal'
        };
        yField = 'value';

        confidenceBands = yMeas.findIndex(meas => meas.agg === 'quartiles') >= 0;
    } else {
        yField = `${yMeas.agg}(${yMeas.field.name})`;
        confidenceBands = yMeas.agg === 'quartiles';
    }

    if (confidenceBands) {
        layer = [
            // TODO: are min/max useful? Or just too much noise?
            /*{
                mark: 'area',
                encoding: {
                    x: {
                        field: xField.name,
                        type: 'ordinal'
                    },
                    y: {
                        field: `${yField}.min`,
                        type: 'quantitative',
                        //axis:  {title: yField}
                    },
                    y2: {
                        field: `${yField}.max`
                    },
                    opacity: {value: 0.1}
                },
            },*/
            {
                mark: 'area',
                encoding: {
                    x: {
                        field: xField.name,
                        type: 'ordinal',
                        axis: { title: this.xTitle.value || xField.name }
                    },
                    y: {
                        field: `${yField}.q1`,
                        type: 'quantitative',
                        axis: { title: this.yTitle.value || yField }
                    },
                    y2: {
                        field: `${yField}.q3`
                    },
                    opacity: {value: 0.3}
                },
            },
            {
                mark: 'line',
                encoding: {
                    x: {
                        field: xField.name,
                        type: 'ordinal'
                    },
                    y: {
                        field: `${yField}.median`,
                        type: 'quantitative',
                        axis: yField
                    }
                },
            },
            {
                mark: 'line',
                encoding: {
                    x: {
                        field: xField.name,
                        type: 'ordinal'
                    },
                    y: {
                        field: `${yField}`,
                        type: 'quantitative',
                        axis: yField
                    }
                },
            }
        ];
    } else {
        layer = [
            {
                mark: 'line',
                encoding: {
                    x: {
                        field: xField.name,
                        type: 'ordinal'
                    },
                    y: {
                        field: yField,
                        type: 'quantitative'
                    }
                },
            }
        ];
    }

    if (encodeColor) {
        layer.forEach(l => l.encoding.color = encodeColor);
    }

    const spec = {
        $schema: 'https://vega.github.io/schema/vega-lite/v3.json',
        data: {name: this.name},
        width: this.plotOutput.offsetWidth - 100,
        height: this.plotOutput.offsetHeight - 100,
        transform,
        layer
    };

    return spec;
}

lineSpec.allAggregates = true;

class PlotEditorResult extends ClientResult {
    constructor(plotEl, output) {
        super();
        this.plotEl = plotEl;
        this.output = output;
    }

    display(targetEl, cell) {
        targetEl.appendChild(this.plotEl);
    }

    toOutput() {
        return Promise.resolve(this.output);
    }
}