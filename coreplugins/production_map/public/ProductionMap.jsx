import L from 'leaflet';
import ReactDOM from 'ReactDOM';
import React from 'React';
import PropTypes from 'prop-types';
import './ProductionMap.scss';
import ProductionMapPanel from './ProductionMapPanel';

class ProductionMapButton extends React.Component {
  static propTypes = {
    metaUrls: PropTypes.array.isRequired,
    tasks: PropTypes.array.isRequired,
    map: PropTypes.object.isRequired
  }

  constructor(props){
    super(props);

    this.state = {
        showPanel: false
    };
  }

  handleOpen = () => {
    this.setState({showPanel: true});
  }

  handleClose = () => {
    this.setState({showPanel: false});
  }

  render(){
    const { showPanel } = this.state;
    const { tasks, metaUrls, map } = this.props;

    return (<div className={showPanel ? "open" : ""}>
        <a href="javascript:void(0);" 
            onClick={this.handleOpen} 
            className="leaflet-control-production-map-button leaflet-bar-part theme-secondary"></a>
        <ProductionMapPanel map={map} isShowed={showPanel} tasks={tasks} metaUrls={metaUrls} onClose={this.handleClose} />
    </div>);
  }
}

export default L.Control.extend({
    options: {
        position: 'topright',
        tasks: [],
        metaUrls: []
    },

    onAdd: function (map) {
        var container = L.DomUtil.create('div', 'leaflet-control-production-map leaflet-bar leaflet-control');
        L.DomEvent.disableClickPropagation(container);
        ReactDOM.render(<ProductionMapButton map={this.options.map} tasks={this.options.tasks} metaUrls={this.options.metaUrls}/>, container);

        return container;
    }
});

